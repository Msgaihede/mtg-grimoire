# MCP server: show a search in the app (project B of the MCP improvements)

Date: 2026-11-25. Status: approved by the owner, 2026-11-25.

The second of five designs for the local MCP server (`apps/desktop/src-tauri/src/mcp/`, reference:
`docs/reference/local-mcp-server.md`). The programme, and the decisions that bind every project, are
§2 of [2026-11-24-mcp-card-knowledge-design.md](2026-11-24-mcp-card-knowledge-design.md)
(project A). B builds on A's branch: it reuses `find_cards`' filter schema (A §6.4).

## 1. Why

The owner's aim for the programme: agents should understand cards, decks, combos, and how cards
fit together. B is the step where an agent's answer leaves the chat. An agent that has found "blue
and red instants under 3 mana that draw a card" can list a dozen names in text. The Search page
shows the same search better: every card's art, what the user owns of each, prices in their
marketplace, the full count. And it lets the user keep going with the app's own controls: narrow
it, sort it, open a card, add it to a deck or the wishlist, which no tool does (A §2). B gives the
agent one tool that puts its search on that page, in the window the user is using, after the user
has said yes in chat.

## 2. Decisions already made

From the programme (A §2, 2026-11-24):

- **The agent asks the user in chat first** ("want to see this in the app?") and calls the tool only
  on a yes. MCP's own way to ask (elicitation) needs a server-to-client stream; this server has
  none (no SSE, `local-mcp-server.md` §1), so asking is the agent's job, taught by the tool's
  description, the server's `instructions` and the `search_cards` prompt.
- **Both kinds of search**: a search text in Scryfall syntax, which the page already parses
  (`packages/ui/features/search/queryLanguage.ts`), and the app's filters.
- **No tool writes the user's cards, decks or wishlists.** B changes what a window shows, which is
  not a write of data.
- **B reuses A's filter schema** (A §6.4), and adds the three filters A left for it: borders,
  finishes, and Universes Beyond/Within.
- **`search_cards` is reworked in B** (and again in C).

From this design's conversation (2026-11-25):

- **The tool waits for the page's answer.** Only the page can read Scryfall syntax until project C
  ports the parser, and the page searches a keyword it does not know as plain words, which can
  quietly empty the wall. So the page reports what it shows: the count, which terms it read as
  keywords, which words it searched as plain text, and any tag it could not find. The agent can
  then tell the user what is on their screen, or fix a typo and offer again.
- **The search goes to the window the user last used, as a hand-off.** The filters land on the filter
  bar's own controls, the oracle tags as tag chips, and the text in the box. Not everything as
  search text, and not a new window per search (§5).
- **A value the bar has no control for goes into the box as a keyword the page reads.** The format
  picker offers 7 of the 23 formats A accepts (`FORMATS`, `useCardSearch.ts:145`), and the
  rarity chips are four of six (`RARITIES`, `filterOptions.ts:89`: no `special`, no `bonus`). Such
  a value goes into the text as `f:premodern` or `r:special`, never as a refusal and never as a
  picker row the bar cannot draw.
- **The window is brought forward, then checked.** Windows can keep a background app behind the
  one in front. So the tool checks whether the window really came forward, flashes its taskbar
  button when it did not, and says so in its answer (§6.2).

## 3. Goals, non-goals, anti-goals

**Goals:**

1. After the user says yes in chat, an agent puts a search on the Search page of the window the
   user last focused, and that window comes to the front, restored if it was minimized. If
   Windows keeps it behind, its taskbar button flashes and the agent is told so.
2. The search text lands in the box as typed. Each filter lands on the control that owns it: the
   format select, the colour row and its Exact toggle, the type, rarity, border, finish and
   Universe chips, the set picker, the mana-value chips and X, Owned, and the price band. The
   oracle tags land as tag chips. Values with no control land in the box as keywords the page
   reads: the game-changer filter as `is:gamechanger`, a format the picker has no row for as
   `f:<key>`, and the `special` and `bonus` rarities as `r:`. Whatever the user had narrowed
   before is cleared, so nothing left over hides the agent's cards.
3. The agent learns what the page shows (§6.4), whether the window came forward, or that the
   window did not answer in time.
4. Every agent is told, in three places, to ask first and to call once per yes.

**Non-goals:** parsing Scryfall syntax in Rust (project C); any write of data; opening any page but
Search (a deck, the collection, a card); opening a new window; the light app (it has no MCP
server); MCP elicitation; the remote tier; any change to `find_cards`.

**Anti-goals, which would make this a failure even if it works:**

- **Two windows changing**, or an arbitrary one. One window changes: the last one the user
  focused.
- **An agent telling the user "they're on your screen" when the wall is empty or never answered.**
  The answer says what the page showed, and a window that did not answer is said to be one.
- **A window changed by a call the tool refused.** Every argument is checked before anything is
  sent, with A's refusal sentences.
- **The agent's cards hidden by the user's leftovers**: a tag chip, a colour or a typed word
  from their last search narrowing the agent's search. The hand-off starts from a clean slate, as
  the quick search's does.
- **A tool that teaches agents to change the screen unasked.** The tool cannot check that the user
  said yes. The rule is written into the description, the `instructions` and the prompt, and the
  change is a view, never data.

## 4. Constraints

- **Rust cannot read the search text** until project C. The tool checks the text's length only;
  the page's report (§6.4) is what tells the agent whether the text meant what it hoped.
- **A tool holds only `Arc<AppState>`.** Its one event route, `state.events` (`WindowEvents` in
  `desktop.rs`), emits to every window. B needs a way to reach one window, and the tool must stay
  testable with no Tauri app (`mcp::tests::state` builds a bare `AppState`).
- **Nothing records which window was focused last.** `window::focused` answers the focused window
  or any. While the user types in their agent's chat, no app window has focus, so "any" would be a
  `HashMap`'s order.
- **A page listening with the global `listen` hears an event aimed at another window**
  (`docs/reference/multi-window.md` §6: one window's snap hover lit both). The page must listen
  on its own window, as `onSnapHover` does (`packages/ui/lib/window.ts`).
- **View state is per window**: the Search page's filters live in window-lifetime memory
  (`lib/viewMemory.ts`), never storage. The hand-off writes that window's state alone.
- **The IPC mirror is held to Rust** (`packages/ui/lib/ipc.test.ts`): every new interface in
  `packages/ui/lib/ipc/mcp.ts` has a Rust struct of its name.
- **The command table is held** (`command_table.rs`): the new desktop command goes on
  `DESKTOP_ONLY` with its reason, beside the seven `mcp_*` commands.
- **Bringing a window forward from a background process is not assured.** Windows' foreground
  lock refuses `SetForegroundWindow` to a process that is not in front, and the multi-window live
  pass saw exactly that (`docs/reference/multi-window.md` §7: `set_focus` refused,
  `SetForegroundWindow` returned `False`). Tauri's `set_focus` goes through tao's
  `force_window_active` (`tao-0.35.3`, `platform_impl/windows/window.rs:1500`). That tries
  `SetForegroundWindow`, and on a refusal it taps Alt (a synthetic press and release, sent to
  whatever app is in front, here the user's chat client) and tries again. tao ignores the result,
  so `set_focus` answers `Ok` whether or not the window came forward. Only a check afterwards can
  tell (§6.2).
- Desktop only. `pnpm verify` once at the end; a live pass over CDP for the window (root
  `CLAUDE.md`).

## 5. Approaches

The owner picked from three (2026-11-25):

1. **A hand-off to the window the user last focused** (chosen). Rust sends one event to that
   window and brings it forward. The page applies the search the way it applies the quick search's
   (`pendingSearchText`), filling its own controls, and reports back through a desktop command. The
   user sees exactly which controls narrowed the wall and can change any of them.
2. **Everything as search text.** Rust spells the filters as Scryfall keywords in the box
   (`f:commander id<=ur otag:ramp r>=rare …`) and reuses `showTextInSearch` unchanged. It is the
   smallest change to the page. But the filter bar stays dark, contrary to "the app's filters", and
   several filters have no keyword the page reads: owned, a price in the reader's marketplace
   currency, mana X, borders, finishes.
3. **A new window for each search.** It never takes over the window the user is working in. But
   windows pile up, each opens on fresh view settings, and the page-side work is option 1's plus
   opening a window and waiting for it to load.

Option 1 takes over a window that may be in a deck editor, a game or a draft. That is what the
quick search (Ctrl+K) already does from anywhere: `setActiveView` parks an open deck, and the game
and draft are held in Rust's slots. The user said yes to seeing the search, and the rail takes them
back.

## 6. The design

### 6.1 The tool: `show_search`

One tool, the 27th. Title "Show a search in the app".

**Arguments** (all optional; a call needs `text`, `filters`, or both):

| Argument | Meaning |
| --- | --- |
| `text` | The Search box's text, in Scryfall syntax as the page reads it: name words, `t:`, `o:`, `kw:`, `pow>=4`, `mv<=3`, `otag:`, `art:`, `-` for not, `or`, parentheses, `!"exact name"`. At most 1,000 characters. |
| `filters` | A's `find_cards` filter object (A §6.4: `format`, `colors`, `colorsExact`, `types`, `rarities`, `sets`, `manaValues`, `manaX`, `owned`, `priceMin`, `priceMax`, `oracleTags`, `gameChanger`), plus `borders` (`regular`, `borderless`, `fullart`; any one), `finishes` (`nonfoil`, `foil`, `etched`: the finishes a printing was made in; any one) and `universe` (`beyond` or `within`). |
| `sort` | `{ "key": …, "descending": bool }`, the key one of the page's eight: `name`, `set`, `type`, `rarity`, `price`, `manaValue`, `released`, `imageUpdated`. Absent: the user's own sort stays. Its own argument because the page drops `order:` and `direction:` from the text (`DISPLAY_KEYWORDS`). |
| `allPrintings` | `true`: a tile per printing; `false`: one per card. Absent: the user's setting stays. |

**Checks, all before anything is sent.** `filters` goes through the same checks `find_cards`
makes, with the same sentences: an unknown field, a value outside its field's words, a format
without legality data, an oracle tag slug that does not resolve. The three new fields get checks
in the same style. A's `filter_fields` builds a `SearchRequest`; B needs the page's shape. So the
vocabulary checks become one function both tools call, with two translations after it. `sort.key`
is checked against the eight keys, and `text` against its length.

**`find_cards` is unchanged.** A left borders, finishes and Universes Beyond out of it on purpose,
since they describe a printing's look, not what a card does. `show_search` takes them because the
page has controls for them.

**No `format` means no format filter**: the page's _Tokens & extras_, which is what `find_cards`
answers with no format and what the quick search's hand-off opens on. So an agent that previews a
search with `find_cards` and then shows it gets the same cards on the wall. A `format` the picker
offers (`FORMATS`: standard, pioneer, modern, legacy, vintage, pauper, commander) sets the format
select to it. Any other format A accepts goes into the text as `f:<key>` (the page reads `f:`,
`format:` and `legal:`), with the select left on _Tokens & extras_.

**Rarities**: when every rarity named has a chip (common, uncommon, rare, mythic), they land on
the chips. When any is `special` or `bonus`, all the named rarities go into the text instead, as
one group: `r:special`, or `(r:rare or r:special)`. They cannot be split between chips and text,
because the chips match any one of their rarities while a term in the box must also hold, so a
split would ask for cards that are rare *and* special.

**Annotations:** `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`,
`openWorldHint: false`. It changes what the user sees, which a client should not treat as a read.
The same call twice leaves the window the same.

**The description** says what it does and puts the rule first: "Ask the user in chat first
('Want to see these in the app?') and call this only after they say yes, once per yes. Changes no
data." It also says the answer reports what the page showed, and that `find_cards` with the same
filters previews the count.

### 6.2 Which window, and bringing it forward

- **The last-focused window** is recorded in Rust: a small tracker fed by the app's window events,
  where `WindowEvent::Focused(true)` records the label and `WindowEvent::Destroyed` forgets it. With no
  record, or the recorded window gone, it falls back to `main`, then to any open window. The
  pure part (a sequence of focus and destroy events gives this label) is unit-tested.
- **Forward, then check** (the owner's pick, 2026-11-25):
  - `unminimize`, `show`, `set_focus`, in that order, keeping tao's Alt-tap workaround (§4).
  - Then ask Windows whether the window is in front (`GetForegroundWindow` against the window's
    handle). Not Tauri's `is_focused`, which this check must not trust until the builder has shown
    it reads the foreground and not the thread's active window.
  - If it is not in front, flash its taskbar button (`request_user_attention`, informational),
    which stops once the user brings the window up.
  - A failure of any step does not stop the hand-off: the window still gets the search.
- **The tool reaches windows through a narrow seam**, not an `AppHandle` in the tool's code. That
  is one trait object reachable from `AppState` (or handed to the server beside it), with one
  method that sends a payload to the chosen window, brings it forward, checks, and answers the
  label and whether it came forward. The desktop implements it over the `AppHandle`; tests use a
  fake that records the payload, says whether the window came forward, and can answer for the
  page.

### 6.3 The hand-off to the page

**Rust to the page**: an event, `search:show`, emitted to the chosen window only, carrying a
`SearchHandoff`:

- `id`: a number unique to this call, which the page sends back with its report.
- `text`: the agent's text, with the keywords for values that have no control appended, each
  separated by a space: ` is:gamechanger` when `filters.gameChanger` is true, ` f:<key>` for a
  format the picker lacks, and the rarity group (§6.1); when a keyword is appended and the agent's
  text holds an `or` (a whitespace-separated word, any case), that text is written in parentheses
  first, because the page binds terms side by side tighter than `or`. The translations into the
  box are written in Rust, so the page receives ready values.
- the filters in the page's own shape: `format` (a key the picker offers, or absent for _Tokens &
  extras_), `colors` (letters) and `colorsStrict`, `types`, `rarities` (chip rarities only, empty
  when they went into the text), `sets`, `manaValues`, `manaX`, `owned`, `priceMin`, `priceMax`,
  `borders`, `finishes`, `universe`.
- `tags`: the oracle tags as `TagRef`s (`slug`, `label`, `namespace: "oracle"`), from the
  `tag_resolve` the check already ran, so the page draws chips with their labels.
- `sort` and `allPrintings`, when given.

**The page's listener** is desktop-only (no other host has a server) and listens on its own window
(§4), mounted once at the desktop face's root. It hands the payload to a store action,
`showSearchHandoff`. Like `showTextInSearch`, that action calls `setActiveView("search")` and then
writes a one-shot field, `pendingSearchHandoff`. `setActiveView` clears that field, and the store
action writes it after the view change, so no caller can order the two the wrong way.

**`SearchPage` applies it** the way it applies `pendingSearchText`: as a seed when the hand-off
is what mounted the page, and as a render-phase adjustment when the page is already mounted (no
`setState` in an effect). It spends the field in an effect. `useCardSearch` gains one action,
`showHandoff` (the shape of `showOnlyText` and `showOnlySet`), which flushes the text past the
debounce, sets every filter the hand-off carries, and puts back every filter it does not. The
picked tags are replaced by the hand-off's
chips (include, oracle namespace), with `useTagSelection({ withoutChips })` on a mount for the
reason given at `SearchPage.tsx:367`. `sort` and `allPrintings` change only when given.

### 6.4 The page's answer

**When the page answers**: once the wall has answered *the handed-off search*, and never the
previous search's placeholder rows (`isPlaceholderData`). That is one of:

- the first page of results for that search arrived;
- the search is held because a tag typed in the text names no tag (`tagNotFound`, the wall
  deliberately empty);
- the tag lookup failed (`tagLookupFailure`);
- the search failed (the query's error).

It answers once per hand-off, through a new desktop command, `mcp_search_shown(id, report)`, on
`command_table::DESKTOP_ONLY`. The report, `SearchShownReport`:

| Field | From the page |
| --- | --- |
| `total`, `totalIsCapped` | `useCardSearch`'s `total` and `totalIsCapped` (rows the wall draws; capped at 5,000) |
| `keywords` | the terms the box read as keywords, as the predicate chips label them (`t:creature`, `pow>=4`), and the tags it read, by label |
| `words` | the words searched as plain text (`parseQuery(text).text`) |
| `unknownTags` | typed tag names that name no tag |
| `failure` | the tag lookup's or the search's sentence, or `null` |

**Rust waits for it.** The tool registers the `id` before it emits, then waits up to 5 seconds. The
tool's answer:

- **Answered**: `{ shown: true, cameForward, total, totalIsCapped, keywords, words, unknownTags }`,
  plus a `note` when there is something to tell:
  - `total` is 0: the page shows nothing and, if `words` holds a `:`, the page did not read that
    term as a keyword;
  - a `failure`: the note is its sentence;
  - `cameForward` is false: the search is on the Search page, but Windows kept the app behind
    and its taskbar button is flashing, so the agent should point the user there.
- **Not answered in time**: `{ shown: null, cameForward, note }`. The search was sent and the window
  has not said what it shows, so the agent should ask the user whether it appeared. This is not a
  refusal (`isError` stays false), since the window may well show it.
- **Replaced**: a second `show_search` while one is waiting answers the first at once with
  `{ shown: false, note: "A later search replaced this one." }`.

A report for an id nothing waits for (late, after the timeout) is dropped. The waiting map lives
where both the tool and the command reach it, and nothing in it outlives its call.

### 6.5 The guidance

- **The tool's description** (§6.1) carries the rule.
- **The server's `instructions`** gain one sentence: `show_search` puts a search on the app's
  Search page and brings the window forward, so offer it in chat first and call it only after the
  user says yes. `rpc.rs`'s `the_instructions_name_the_guide_and_the_new_tools` gains
  `show_search` in its list.
- **The `search_cards` prompt, reworked** (`mcp/prompts/search_cards.md`):
  - The "pick the tool" table gains a row: "show me these in the app" or "let me look through
    them" → `show_search`, after a yes.
  - A new section, **Showing a search in the app**:
    - When to offer it: more cards than a chat list reads well, a search the user will want to
      browse or refine, or cards the user wants to act on (add to a deck or the wishlist, which
      the tools never do).
    - Ask first, call once per yes, and never because a search merely could be shown.
    - Preview with `find_cards` and the same `filters` when the count matters.
    - How to split a request between `filters` (what the filter bar holds) and `text`
      (everything else, in Scryfall syntax).
    - The short list of what the page does not read: regular expressions, `~`, `cube:`,
      `order:` and the other display keywords (use `sort`).
    - How to read the answer back: a 0 with a keyword left in `words`, and `cameForward: false`
      (tell the user to click the app's flashing taskbar button).
  - The graph section stays as it is. Project C's `scryfall_syntax` prompt will hold the whole
    syntax. B's section keeps to what an agent needs to fill the box, and C reworks the prompt
    again once the tools read Scryfall syntax themselves.
- `read_guide` needs no change, since `search_cards` is already in its enum.

### 6.6 Documentation

- `docs/reference/local-mcp-server.md`: the tool table gains `show_search`, and a short section
  covers the window it picks, the hand-off, the page's answer and the timeout. §2's line "It writes
  nothing of the reader's cards…" stays true, and the page gains "and changes what one window
  shows". §6's line on project B goes.
- `apps/desktop/src-tauri/CLAUDE.md`, the MCP bullet: 27 tools, `show_search`, the one event aimed
  at one window, and `mcp_search_shown` on `DESKTOP_ONLY`.
- `docs/reference/multi-window.md` §6 says snap hover "is the only window-targeted event the page
  listens to". `search:show` is a second one, and the page says so.
- `packages/ui/CLAUDE.md` §4's list of one-shot hand-offs gains `showSearchHandoff`.

## 7. Testing

- **Rust, `mcp/tools.rs`**, against a real database on disk with the fake window seam:
  - every refusal sentence: an empty call, the new fields' values, a bad `sort.key`, text over
    1,000 characters, and A's filter refusals reached through the new tool;
  - the payload the fake receives:
    - tags with their labels;
    - ` is:gamechanger` appended;
    - a picker format on the select, `f:premodern` in the text;
    - chip rarities on the chips, and `rarities: ["rare", "special"]` as
      `(r:rare or r:special)` in the text with no chips;
    - the filters in the page's shape;
    - `sort` and `allPrintings` only when given;
  - the answer when the fake answers for the page, including the 0 note and the
    `cameForward: false` note;
  - the timeout answer, with the wait shortened in tests;
  - the replaced answer.
- **Rust, the window tracker**: focus and destroy sequences pick the right label, and fall back
  to `main`, then any.
- **Rust, the command**: `mcp_search_shown` resolves a waiting call and drops an unknown id.
  `command_table::` passes with the new `DESKTOP_ONLY` entry. The `instructions` test names
  `show_search`, and the tool-count test (`tools.rs`, 26 today) expects 27.
- **TypeScript**:
  - the store action (the view and the field; the field cleared by `setActiveView`);
  - `SearchPage` mounting on a hand-off and receiving one while mounted: the box, each filter
    control, the chips, the sort, and leftovers cleared;
  - the report sent once, after the real answer and never on placeholder rows, including the
    unknown-tag and failure cases;
  - the listener using the window's own `listen`.
- **The mirror**: `SearchHandoff` and `SearchShownReport` pass `ipc.test.ts`. The Storybook fake
  answers `mcp_search_shown` if any story reaches it.
- **Live, over CDP, on the real app**:
  - call the tool over HTTP with text and filters while the window is behind another app, and
    again while it is minimized: the window draws the search, and either comes forward with
    `cameForward: true` or stays behind with its taskbar button flashing and `cameForward: false`
    (record which, and whether tao's Alt tap did anything visible to the app in front);
  - the same from a real agent client (Claude Code in a terminal), where the client's window is
    the one in front;
  - the tool's `total` equals the wall's caption;
  - with two windows open, only the last-focused one changes;
  - a typo'd keyword answers the 0 note.

## 8. Calls made in this design that the owner did not make

Each can be overruled:

1. `sort` and `allPrintings` are arguments, because the page drops `order:` from the text; the
   layout (grid or table) stays the user's.
2. No `format` means _Tokens & extras_, matching `find_cards` and the quick search's hand-off,
   rather than the page's own default, _Any format_.
3. `find_cards` stays as A left it. Only `show_search` takes borders, finishes and Universe.
4. Oracle tags arrive as tag chips (include only); excluded tags and art tags go in the text
   (`-otag:`, `art:`), which the page reads.
5. The game-changer filter is ` is:gamechanger` appended to the text, since the page has no
   control for it.
6. Annotated `readOnlyHint: false` (it changes the screen), which may make a client ask for
   permission on top of the user's yes in chat.
7. A 5-second wait; a window that does not answer is reported as sent and unanswered, not as
   an error.
8. A second call while one waits answers the first as replaced.
9. A busy window (a deck editor, a game, a draft) is taken over, as the quick search does,
   rather than a new window opened.
10. When any named rarity has no chip, all the named rarities go into the text as one `or` group
    rather than splitting between chips and text (§6.1).
11. The foreground check uses `GetForegroundWindow`, and the flash is `request_user_attention`'s
    informational kind (it stops when the window is brought up), not the critical kind, which
    keeps flashing.

## 9. Left to the builder

- The seam's exact shape and where the waiting map lives (`AppState`, the MCP slot, or a managed
  value of its own), within §6.2's rule that tools never hold an `AppHandle` directly.
- How the shared filter checks are factored out of `filter_fields`.
- Where the desktop face mounts the listener (`DesktopBoot` or its child).
- Exact wording of the description, the `instructions` sentence, the notes and the prompt.
- The order of work and how it is split into commits.
