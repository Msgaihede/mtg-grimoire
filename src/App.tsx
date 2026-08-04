import { QueryClientProvider } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { SearchPage } from "@/features/search/SearchPage";
import { queryClient } from "@/lib/query";
import { useAppStore, type ViewId } from "@/lib/store";

/** What each view says while it is still a placeholder. */
const BLURB: Record<Exclude<ViewId, "search">, { title: string; body: string }> = {
  collection: {
    title: "Collection",
    body: "Owned cards, quantities and value. Coming in a later plan.",
  },
  wishlist: {
    title: "Wishlist",
    body: "Cards you are hunting for, with owned badges in search. Coming in a later plan.",
  },
  decks: {
    title: "Decks",
    body: "Deckbuilder, format validation and deck stats. Coming in a later plan.",
  },
  settings: {
    title: "Settings",
    body: "Data folder, sync behaviour, import and export. Coming in a later plan.",
  },
};

function ActiveView() {
  const activeView = useAppStore((s) => s.activeView);
  if (activeView === "search") return <SearchPage />;

  const { title, body } = BLURB[activeView];
  return (
    <section className="mx-auto max-w-prose py-16 text-center">
      <h2 className="font-heading text-xl">{title}</h2>
      <p className="mt-2 text-sm text-muted">{body}</p>
    </section>
  );
}

/**
 * The whole app.
 *
 * `QueryClientProvider` is here rather than in `main.tsx` so that any test can render
 * `<App />` and get the real caching behaviour; `AppShell` deliberately needs no
 * provider of its own (see `useSync`).
 */
export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppShell>
        <ActiveView />
      </AppShell>
    </QueryClientProvider>
  );
}
