# Creating a custom home widget in MTG Grimoire

You are building the user a widget for MTG Grimoire's home page: a GraphQL data query over their
data, and a json-render spec drawn from the app's own components. The app stores it, and the user
places it from the **Custom widgets** button beside **Add widget** on the home page.

## Steps

1. **Understand the widget.** What it shows, what the user might want to change about it (those are
   its settings), and roughly how big (a footprint of 2–12 by 2–8 grid cells; 4 × 3 is a good start).
2. **Write the data query** against `graph_schema` (the `graphql_discovery` prompt explains the
   graph). Check it with `graph_validate`; run it with `graph_query` to see real data.
3. **Write the spec** from the catalogue below. The query answer's `data` is the state root:
   `{ "$state": "/decks/0/name" }` reads the query's `decks`. The widget's own inputs live under
   `/ui`; its settings under `/settings`, drawn in the card's settings popover through a top-level
   `settingsRoot`, never on the widget. A setting can change what the query asks: declare a variable
   named after it and seed the setting in `state.settings`.
4. **Check both halves** with `widget_check` (it stores nothing), and **look at the state** the spec
   will be drawn over with `widget_preview` — check every `$state`, `$item` and `repeat` path
   against it. Fix and repeat until both are clean.
5. **Store it** with `widget_create` (`name`, `description`, `query`, `spec`, `w`, `h`), then tell the
   user to open the home page, press **Customize**, then **Custom widgets**, and add it.
6. **To change a widget later**, `widget_list` and `widget_get` find it, and `widget_update` changes
   only what you pass. `widget_delete` removes it and its cards; do that only when the user asks.

## Keep in mind

- A widget is small: one idea, and Figures, Bars or a RowList over long text.
- Colours are palette words; money goes through `money: true`, a `Price`, or `formatPrice`.
- Optional props are `null`, never left out. Every element carries `children` (`[]` for a leaf).
- Actions only navigate. A widget cannot change the user's cards, decks or wishlists.

## The widget catalogue
