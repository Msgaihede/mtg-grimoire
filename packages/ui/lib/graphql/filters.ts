/**
 * A card search box's words, turned into the `CardFilters` a list command takes — for a field's
 * `query: String` argument.
 *
 * **The graph takes Scryfall's syntax rather than mirroring `CardFilters` as an input type.**
 * The syntax is what this app's every search box already speaks, it is what a person (or a model
 * writing a widget for one) already knows, and `queryLanguage.ts` is the one parser for it — so
 * `t:creature c:g otag:ramp` here means exactly what it means in the Search page. Mirroring the
 * filter record instead would be a second, structural spelling of the same question with its own
 * drift to fence.
 *
 * **A tag fails closed**, as the deck editor's box does (`useDeckCardQuery`): a tag no taxonomy
 * knows is an error naming it, never a filter quietly dropped — a widget showing every card
 * because `otag:rmap` matched nothing would be a wrong answer that looks like a right one.
 */
import { parseQuery, wirePredicate } from "@/features/search/queryLanguage";
import { termsFor, type TagChip } from "@/features/tags/tagFilters";
import { ipc, type CardFilters } from "@/lib/ipc";

export async function filtersFromQuery(query: string | null | undefined): Promise<CardFilters> {
  const input = query?.trim() ?? "";
  if (input === "") return {};
  const parsed = parseQuery(input);
  const out: CardFilters = {};
  if (parsed.text !== "") out.text = parsed.text;
  if (parsed.predicates.length > 0) out.predicates = parsed.predicates.map(wirePredicate);
  if (parsed.tags.length === 0) return out;

  const answers = await ipc.tagResolve(
    parsed.tags.map((t) => ({ namespace: t.namespace, value: t.value })),
  );
  const chips: TagChip[] = [];
  parsed.tags.forEach((token, i) => {
    const ref = answers[i];
    if (ref === null || ref === undefined) {
      throw new Error(`No ${token.namespace} tag is called "${token.value}".`);
    }
    chips.push({
      slug: ref.slug,
      label: ref.label,
      namespace: ref.namespace,
      mode: token.negated ? "exclude" : "include",
    });
  });
  const { artTags, oracleTags } = termsFor({ chips, namespace: "both", floor: "any" });
  if (artTags) out.artTags = artTags;
  if (oracleTags) out.oracleTags = oracleTags;
  return out;
}
