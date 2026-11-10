import { useState } from "react";
import { parseBulkPrice, parseMinimumValue, parseSellPercent } from "@/lib/collectionValue";
import type { CollectionValue } from "@/lib/ipc";
import { useSeededDrafts } from "@/lib/useSeededDrafts";

type Field = keyof CollectionValue;

/** The boxes in the order they are drawn, which is the order their sentences are said in. */
const FIELDS: readonly Field[] = ["sellPercent", "minimumValue", "bulkPrice"];

const PARSE: Record<Field, (text: string) => number | null> = {
  sellPercent: parseSellPercent,
  minimumValue: parseMinimumValue,
  bulkPrice: parseBulkPrice,
};

/** Each figure as its box draws it. An empty box is the default, which is how one is turned off. */
export function reductionText(settings: CollectionValue): Record<Field, string> {
  return {
    sellPercent: settings.sellPercent === 100 ? "" : String(settings.sellPercent),
    minimumValue: settings.minimumValue === 0 ? "" : settings.minimumValue.toFixed(2),
    bulkPrice: settings.bulkPrice === 0 ? "" : settings.bulkPrice.toFixed(2),
  };
}

/**
 * The three boxes of a reduced price — Settings › Collection value and Open Packs' own — as
 * controlled drafts (issue #1589).
 *
 * **Each box's refusal is its own.** A refused box keeps its draft and its sentence until it is
 * fixed or its stored figure moves; a commit on another box stores that box and says nothing over
 * it. A sentence is said only while its box still holds the draft it refused, so a re-seed (another
 * window, a Reset) takes the sentence with the draft.
 */
export function useReductionDrafts(
  settings: CollectionValue,
  write: (settings: CollectionValue) => void,
  sentences: Record<Field, string>,
): {
  drafts: Readonly<Record<Field, string>>;
  setDraft: (field: Field, text: string) => void;
  /** One box taken: stored if it reads and says something new, or its sentence kept. */
  commit: (field: Field) => void;
  /** The refused boxes' sentences, in box order, or `null` with none. */
  refusal: string | null;
  /** Every box back to what is stored, and every sentence dropped. */
  reset: () => void;
} {
  const { drafts, setDraft, setDrafts, reseed, edited } = useSeededDrafts(reductionText(settings));
  const [refused, setRefused] = useState<ReadonlySet<Field>>(new Set());

  const mark = (field: Field, on: boolean) =>
    setRefused((before) => {
      if (before.has(field) === on) return before;
      const next = new Set(before);
      if (on) next.add(field);
      else next.delete(field);
      return next;
    });

  const commit = (field: Field) => {
    const value = PARSE[field](drafts[field]);
    if (value === null) return mark(field, true);
    mark(field, false);
    const next = { ...settings, [field]: value };
    // The figure in its own form — `0.5` reads back as `0.50` — whether or not it was new.
    setDrafts({ [field]: reductionText(next)[field] });
    if (value !== settings[field]) write(next);
  };

  const said = FIELDS.filter((f) => refused.has(f) && edited(f)).map((f) => sentences[f]);
  return {
    drafts,
    setDraft,
    commit,
    refusal: said.length === 0 ? null : said.join(" "),
    reset: () => {
      setRefused(new Set());
      reseed();
    },
  };
}
