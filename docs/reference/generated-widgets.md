# Generated widgets: the json-render catalogue

A home widget the reader generates is declarative: a GraphQL document over the read graph
([graphql.md](graphql.md)) for its data, and a [json-render](https://json-render.dev) spec for its
picture. This page is the picture half — the **component catalogue** a spec may be built from, and
how each name is drawn with this app's own components. Added 2026-10-29; nothing on screen uses it
yet (the `custom` widget kind, the answer-to-state adapter and the MCP's spec tools come next).

It lives in [`packages/ui/features/home/generated/`](../../packages/ui/features/home/generated/).
Not to be confused with the **Widget catalogue** (`WidgetCatalogue.tsx`), the dialog a reader adds a
widget kind from.

## The files

| File                    | What                                                                                                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalog.ts`            | `defineCatalog` — every component, action and function a spec may name, with zod props and a description written for the model. `catalog.prompt()`, `.validate(spec)`, `.jsonSchema()` |
| `registry.tsx`          | `defineRegistry` — each name drawn with the app's own part; the actions as store hand-offs; `useCatalogFunctions()`, the `$computed` functions at the reader's marketplace             |
| `SpecView.tsx`          | One spec drawn: the store, the providers, the registry, the handlers and the functions in one place, so a widget body, a story and a test draw a spec the same way                     |
| `examples.ts`           | Worked specs with the state an answer would hand them — the stories draw them, the suite validates and renders them                                                                    |
| `catalog.test.tsx`      | Catalogue and registry name the same components; the prompt names everything; every example validates; drawing, binding, visibility, `$computed`; each action's hand-off               |
| `catalog.prompt.md`     | `catalogPrompt()` — json-render's prompt with this app's rules (`CATALOG_RULES`). A committed snapshot                                                                                 |
| `catalog.contract.json` | `catalogContract()` — every component's props and every action's params as JSON Schema, with slots and descriptions. A committed snapshot                                              |

**The two snapshots are for the desktop's MCP server**, which hands a model the vocabulary and
checks its spec with no TypeScript running — the read graph's `schema.graphql`, for the picture
half. `catalog.test.tsx` holds both to the catalogue byte for byte (`toMatchFileSnapshot`);
`pnpm vitest run -u` rewrites them after an intended change, and `.prettierignore` keeps Prettier
off them. json-render's own `jsonSchema()` is not enough for that job: it describes the spec's
envelope, with every component's props an open object.

json-render is pinned exact (`@json-render/core` and `@json-render/react` 0.21.1, with `zod` 4 as
its peer): it is young and its minor versions move.

## What is in it

- **Layout and text**: `Stack`, `Grid`, `Divider`, `Panel` (`StatsCard`), `Heading`, `Text`,
  `ManaText`, `Price`, `Hint` (the app's tooltip over its children).
- **The home widgets' own parts** (`WidgetParts.tsx`): `Figures`, `Bars`, `RowList`, `Row`,
  `Message`, `Footer`. The measured ones (`Figures`, `Bars`, `RowList`) read the widget card's
  `WidgetFit` from `CatalogFitContext`; outside a card it is a medium card's.
- **Charts**: `PriceChart` (`priceHistory/PriceChart`, money over time), `ColumnChart` (the deck
  stats band's `BarChart` — card counts, `mana: true` for the curve's circled numerals),
  `PriceHistogram` (Draft & Packs' `ValueHistogram`, binned by its own `histogram`). A horizontal
  breakdown is `Bars`.
- **Cards and their marks**: `CardArt`, `CardTile`, `RarityGem`, `FinishMark`, `SetSymbol`,
  `CountTag`, `OwnedBadge`, `GameChangerMark`.
- **Inputs**, each the control the app already uses for the job:

  | Name            | Drawn by                       | Binds                 |
  | --------------- | ------------------------------ | --------------------- |
  | `Button`        | `BUTTON` (Settings' controls)  | — (`press` event)     |
  | `TextInput`     | an input with `TOUCH_FIELD`    | `value`               |
  | `Select`        | `Dropdown`                     | `value`               |
  | `Combobox`      | `Dropdown` with `searchable`   | `value`               |
  | `MultiSelect`   | `MultiDropdown`                | `selected` (an array) |
  | `Segmented`     | Draft & Packs' `Segmented`     | `value`               |
  | `RadioGroup`    | the importer's `ModeRadios`    | `value`               |
  | `Switch`        | `SWITCH` + `switchTone`        | `checked`             |
  | `ToggleChip`    | the Search page's `ToggleChip` | `pressed`             |
  | `NumberStepper` | `QuantityStepper`              | `value`               |
  | `PriceRange`    | the Search page's `PriceRange` | `min` and `max`       |

- **The widgets' own settings controls** (`WidgetSettingsPanel.tsx`, exported from there and used
  by the panel and the kinds' settings alike): `FieldGroup` (`SettingsGroup`), `ChoiceChips`
  (`SettingsChips` — every pick and the density), `Checkbox` (`SettingsCheck` — the `Show`
  switches), `Checklist` (Summary's figures), `CompactStepper` (`SettingsStepper` — `Wide`/`Tall`),
  `Picker` (`SettingsPicker` — the deck, folder and wishlist pickers, searchable past eight) and
  `CardSearch` (Price movers' `CardPicker`). `CardSearch` is the one input that reads data of its
  own: it searches the card database as the price movers' picker does.

Left out on purpose: dialogs, menus and the virtual table (a widget is a tile, not a page), and
controls tied to one feature's data (`TagChips`, `FinishRadios`, `SyncProgress`, `ValueChart`'s
history views).

A component is a picture of facts it is handed: nothing in the catalogue fetches, `CardSearch`'s
card search aside.

## Rules

- **Draw with the app's part, never a second idea of it.** `Figures` is `WidgetFigures`, `Row` is
  `WidgetRow`, `CardTile` is `CardTile`, `Price` is `formatPrice` — so a generated widget wears the
  app's tokens, sizes and press feedback, and a change to a part changes every widget built from it.
  `defineRegistry` types each entry against its catalogue props, so a prop renamed on one side is a
  compile error on the other, and the suite fails on a name on one side only.
- **Colours are words from the palette** (`accent`, `up`, `down`, `dim`, the five mana colours and
  colourless), never a free colour: `catalog.validate` refuses `#ff00ff`.
- **State has three parts.** The widget's GraphQL answer is the state root (`/decks/0/name` is
  the query's `decks` field); `/ui` is the widget's own inputs (a filter, a sort, a switch); and
  `/settings` is what the reader configures and keeps. A model seeds only `/ui` and `/settings`,
  never sample data for the query's fields — `CATALOG_RULES` overrides json-render's own rule,
  written for pages that invent their data. The examples keep the same layout.
- **Inputs write only the widget's own state** (`$bindState` under `/ui` or `/settings`). The
  graph is read-only and so is a widget: an input filters, sorts or switches what it draws, never
  the reader's data.
- **Actions navigate**, through the store hand-offs the hand-written widgets use and in their
  order (`setActiveView` before a one-shot like `setOpenDeckId`):

  | Action             | Goes to                                                    |
  | ------------------ | ---------------------------------------------------------- |
  | `openCard`         | a printing's card details                                  |
  | `openDeck`         | a deck in the editor                                       |
  | `openFolder`       | a collection or wishlist folder                            |
  | `openView`         | one of the app's pages                                     |
  | `showSet`          | Search, showing one set                                    |
  | `searchText`       | Search, showing what a text or query finds                 |
  | `showInCollection` | the Collection, filtered by a query                        |
  | `revealCard`       | the folder a card is filed in, filtered to it              |
  | `openDeckFolder`   | the Decks gallery, standing in one deck folder             |
  | `openReview`       | the Collection or Wishlist, its flagged rows only          |
  | `openSettings`     | Settings, one panel in view (Settings' own list, `nav.ts`) |
  | `openPriceHistory` | a printing's price history for one finish                  |
  | `openPrintings`    | the dialog of every printing of a card                     |
  | `goldfish`         | a deck's solo practice game (desktop only)                 |

  No action writes the reader's data; adding one is the owner's decision.

- **Two actions are the host's**: `refresh` (ask the widget's document again) and `saveSettings`
  (keep the state under a path — `/settings` — in the widget's stored config). `SpecView` answers
  them through its `host` prop; drawn without one (a story, a preview) they do nothing. The custom
  widget kind will be that host.
- **A `$item` in an action's params arrives as a state path.** json-render resolves it to the
  item's path (`/decks/1/id`), the shape its own `setState` needs, and its prompt tells a model so.
  The actions read such a param back from the spec's state (`valueOf` in `registry.tsx`); no value
  they take begins with `/`. That is why `SpecView` runs on a store of its own: the handlers read it.
- **Conclusions TypeScript owns are `$computed` functions**: `formatPrice` (at the reader's
  marketplace — a spec never spells a currency), `formatNumber`, `formatPercent`, `formatDate`.
- **Optional props are `.nullable()`**, json-render's convention: a model sends `null` for a prop it
  leaves out. Every element carries `children`, `[]` for a leaf — `validate` requires it.
- **Content security**: json-render renders React elements only — no `eval`, no `innerHTML`, no
  injected styles — so a spec stays inside `script-src 'self'` and `style-src 'self'`. `Grid`'s
  column count is an inline `style` attribute, which the policy allows. **zod runs jitless**
  (`zodConfig.ts`, imported first by `catalog.ts`): zod 4 probes for `new Function` on its first
  parse, and the browser reports the refused probe as a `script-src eval` violation even though zod
  catches it — which `pnpm web:scanner-smoke` fails the web app on. `csp.test.ts` holds it.

## Stories

`Home/Generated/SpecView`: Decks (figures, a `repeat` of rows that open their deck, a `$template`
footer), Rarity (bars, a switch hiding them), Filter (rows narrowed by a chip and a price range
through `visible`), Settings (the widgets' settings controls, saved
through `saveSettings`), Cards (a wall of tiles over the fake's printings) and Gallery (one of every
component). Each spec sits in a box a widget of its footprint covers, with
that box's fit.

## Stored custom widgets (Rust)

A reader's own widget is stored as a **definition**: a name, a description, the GraphQL query (as
written), the json-render spec and the footprint it is placed at. The table is `custom_widgets`
(user schema v68, `crates/grimoire-core/src/custom_widgets.rs`); a placed one is a home layout
entry of kind `custom` with `config: { widgetId, name, settings? }`, which `home.rs` stores like any
other entry.

- **Device-local, and in the full export** (the owner's decision): not on `SYNCED_TABLES`, no
  `sync_uid`, no capture spec — but a user table, so `archive` exports and restores it with the
  rest. The spec is JSON text under a `json_valid` CHECK.
- **Four table commands**, each with a desktop wrapper (`apps/desktop/src-tauri/src/custom_widgets/`):
  `custom_widgets` (every definition, by `name COLLATE NOCASE, id`; fallible),
  `custom_widget_create(name, description, query, spec, w, h)`,
  `custom_widget_update(id, name?, description?, query?, spec?, w?, h?)` (an absent field is left;
  `updated_at` moves) and `custom_widget_delete(id)`. Both answer `CustomWidget`; an unknown id is
  `That widget is not there any more.`
- **The core checks the shape, never the vocabulary** — `home.rs`' rule. Refused in a sentence and
  before the write: a name blank after trimming or over 80 characters, a description over 500, a
  query blank or over 20 000 bytes, a spec that is not an object with a string `root` and an object
  `elements` or is over 200 000 bytes serialized, a width outside 2–12 or a height outside 2–8.
  Component names, props and the query's validity are not looked at.
- **The desktop's MCP server** ([local-mcp-server.md](local-mcp-server.md)) adds `widget_list`
  (id, name, description, footprint) and `widget_create`, which checks the query with the read
  graph and the spec against `catalog.contract.json` — every element's type a component, its props
  declared and the required ones present, its children real keys, its actions the catalogue's or
  json-render's four built-ins — before it calls `custom_widget_create`. That is the contract
  snapshot's first Rust reader.

## Drawing a custom widget (the page)

A placed copy is the `custom` kind's body, `generated/CustomWidget.tsx`; the dialog that places
copies and the header button that opens it are [home-page.md](home-page.md) §18.

- **The answer becomes the state in one module, `generated/widgetState.ts`.** The answer's `data`
  is the state root, so a spec's paths are its query's field paths and nothing translates between
  them. `/ui` is seeded from the spec's `state.ui` and never stored. `/settings` is seeded from the
  spec's `state.settings`, with what the copy saved (`config.settings`) laid over it key by key, so
  a setting a newer spec added keeps its default. `ui` and `settings` are the widget's whatever the
  answer names; any other key the spec seeded is sample data, and the answer replaces it.
- **A refreshed answer moves the data and nothing else.** `SpecView`'s `live` writes the answer's
  top-level keys into the store each time it changes, so a reader's filter survives the collection
  changing under it. A changed definition (`updatedAt`) remounts, from its own seeds.
- **The body is the host** for `refresh` (`useGraphQL`'s `refetch`) and `saveSettings` (the state
  under the path, written to the copy's `config.settings`), so two copies of one definition can be
  set differently.
- **Checked before it is drawn**: the spec through `catalog.validate` (`checkSpec`, the first issue
  in words), the query only by asking the graph. It says so instead of drawing when the definition
  is gone, the spec is refused, the document is refused or the graph is not on this host; a partial
  answer is drawn with one dim line under it.
- **The fake answers what a world seeds** (`FakeDb.graphAnswers`, keyed by the trimmed document):
  `starter` seeds two definitions and their answers, so the stories draw a custom widget end to end.
