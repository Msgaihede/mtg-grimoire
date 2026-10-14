/**
 * Where a folder's rules are written (issue #980, spec §5) — `Folder options → Rules…` on a user
 * collection folder and on every wishlist folder.
 *
 * **Rules never stop a card being filed**, and the dialog says so in its subtitle: they only mark
 * the cards that do not match. Not deck validation, not tags, not the lock
 * (`docs/agent/DOMAIN_VOCABULARY.md`).
 *
 * **Presentational.** The host owns the write (`setRules`) and hands back its refusal as `error`;
 * this dialog only knows the list the reader built. Save writes the whole list — an emptied list
 * clears the folder's rules, which is the backend's `NULL`.
 *
 * **Inherited rules are read-only here** and listed under the folder they come from: they are
 * that folder's to edit, and a subfolder that could rewrite its parent's rules from inside itself
 * would be editing a drawer the reader did not open.
 */
import { useId, useRef, useState, type ReactElement } from "react";
import { Plus, X } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import { ManaChip, RarityChip, ToggleChip } from "@/components/FilterChips";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { CONFIRM_CANCEL, META_SUBMIT_TYPED } from "@/features/decks/metaRows";
import { FIELD } from "@/features/decks/formFields";
import { SetCombobox } from "@/features/search/SetCombobox";
import {
  describeRule,
  kindsFor,
  MAX_RULES,
  RULE_KIND_LABEL,
  RULE_VALUES,
  validateRules,
  valueLabel,
  type InheritedRules,
  type ValuesRuleKind,
} from "@/lib/folderRules";
import { FOCUS } from "@/lib/focus";
import type { FolderRule, FolderRuleKind } from "@/lib/ipc";
import type { ManaKey } from "@/lib/mana";
import { formatPrice } from "@/lib/prices";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";

export interface FolderRulesDialogProps {
  open: boolean;
  /** Which page's folder — a wishlist folder is never offered a condition rule. */
  scope: "collection" | "wishlist";
  folderName: string;
  /** The folder's **own** rules — what Save replaces. */
  rules: readonly FolderRule[];
  /** Its ancestors' rules, nearest first (`effectiveRules`), drawn read-only. */
  inherited: readonly InheritedRules[];
  /** The write is in flight. */
  pending?: boolean;
  /** The backend's refusal, in its own sentence, drawn above the footer. */
  error?: string | null;
  onSave: (rules: FolderRule[]) => void;
  onClose: () => void;
}

export function FolderRulesDialog({
  open,
  scope,
  folderName,
  rules,
  inherited,
  pending = false,
  error = null,
  onSave,
  onClose,
}: FolderRulesDialogProps): ReactElement {
  return (
    <Dialog
      open={open}
      title={`Rules for “${folderName}”`}
      subtitle="Cards filed here should match every rule. Nothing is refused for breaking one — it is outlined in red."
      closeLabel="Close"
      size="w-[44rem]"
      onDismiss={onClose}
      onClose={onClose}
    >
      <Body
        scope={scope}
        rules={rules}
        inherited={inherited}
        pending={pending}
        error={error}
        onSave={onSave}
        onClose={onClose}
      />
    </Dialog>
  );
}

/**
 * One rule as the reader is editing it. **Text for the ends, not numbers** — a box holding `1.`
 * on its way to `1.5` is not a number yet, and a draft that parsed on every keystroke would eat
 * the dot. The text becomes a rule only when it is validated and when it is saved.
 */
interface Row {
  key: number;
  kind: FolderRuleKind;
  /** `min` / `from`. */
  lo: string;
  /** `max` / `to`. */
  hi: string;
  values: string[];
}

function toRow(rule: FolderRule, key: number): Row {
  switch (rule.kind) {
    case "price":
    case "manaValue":
      return { key, kind: rule.kind, lo: num(rule.min), hi: num(rule.max), values: [] };
    case "released":
      return { key, kind: rule.kind, lo: rule.from ?? "", hi: rule.to ?? "", values: [] };
    default:
      return { key, kind: rule.kind, lo: "", hi: "", values: [...rule.values] };
  }
}

const num = (v: number | null): string => (v === null ? "" : String(v));

/** Not one of the tidy's sentences: the backend never sees a box's text, only a number. */
const NOT_A_NUMBER = "Write each end of a range as a number.";

/** A box's text as an end: blank is unbounded, `NaN` is a refusal. A comma is read as the decimal
 *  point, as `parsePrice` reads a purchase price. */
function parseEnd(text: string): number | null {
  const t = text.trim();
  return t === "" ? null : Number(t.replace(",", "."));
}

function toRule(row: Row): FolderRule {
  switch (row.kind) {
    case "price":
    case "manaValue":
      return { kind: row.kind, min: parseEnd(row.lo), max: parseEnd(row.hi) };
    case "released": {
      const from = row.lo.trim();
      const to = row.hi.trim();
      return { kind: row.kind, from: from === "" ? null : from, to: to === "" ? null : to };
    }
    default:
      return { kind: row.kind, values: row.values };
  }
}

/** The first reason Save is out of reach, or `null`. A box that is not a number is said first,
 *  because `validateRules` would read its `NaN` as a range with no lower end. */
function draftRefusal(rows: readonly Row[]): string | null {
  const unparsed = rows.some(
    (r) =>
      (r.kind === "price" || r.kind === "manaValue") &&
      [r.lo, r.hi].some((t) => Number.isNaN(parseEnd(t))),
  );
  if (unparsed) return NOT_A_NUMBER;
  return validateRules(rows.map(toRule));
}

/**
 * The draft and the footer — **separate from the shell for `NoteEditorDialog`'s reason**: a closed
 * `Dialog` mounts no children, so every open starts on a fresh draft seeded from `rules` and
 * nothing has to reset it.
 */
function Body({
  scope,
  rules,
  inherited,
  pending,
  error,
  onSave,
  onClose,
}: Omit<FolderRulesDialogProps, "open" | "folderName" | "pending" | "error"> & {
  pending: boolean;
  error: string | null;
}) {
  const id = useId();
  const { marketplace } = useMarketplace();
  const money = (v: number) => formatPrice(v, marketplace.currency);
  const nextKey = useRef(rules.length);
  const [rows, setRows] = useState<Row[]>(() => rules.map(toRow));

  const refusal = draftRefusal(rows);
  const full = rows.length >= MAX_RULES;

  const update = (key: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const remove = (key: number) => setRows((rs) => rs.filter((r) => r.key !== key));
  const add = (kind: string) => {
    const known = kindsFor(scope).find((k) => k === kind);
    if (known === undefined) return;
    const key = nextKey.current++;
    setRows((rs) => [...rs, { key, kind: known, lo: "", hi: "", values: [] }]);
  };

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
        {rows.length === 0 ? (
          <p className="text-sm text-dim">
            No rules of its own. Add one, and every card filed here is checked against it.
          </p>
        ) : (
          <ol className="flex flex-col gap-3">
            {rows.map((row, i) => (
              <RuleRow
                key={row.key}
                row={row}
                n={i + 1}
                currency={marketplace.currency.toUpperCase()}
                onChange={(patch) => update(row.key, patch)}
                onRemove={() => remove(row.key)}
              />
            ))}
          </ol>
        )}

        <div className="flex items-center gap-2">
          <Dropdown
            label={full ? `Add rule (at most ${MAX_RULES})` : "Add rule"}
            placeholder="Add rule"
            value=""
            size="sm"
            align="start"
            disabled={full}
            options={kindsFor(scope).map((k) => ({
              value: k,
              label: RULE_KIND_LABEL[k],
              icon: <Plus className="size-3.5" aria-hidden="true" />,
            }))}
            onChange={add}
          />
        </div>

        {inherited.map((group) => (
          <section
            key={group.folderId}
            aria-labelledby={`${id}-from-${group.folderId}`}
            className="border-t border-border pt-3"
          >
            <h3 id={`${id}-from-${group.folderId}`} className="text-xs text-dim">
              From “{group.folderName}”
            </h3>
            <ul className="mt-1.5 flex flex-col gap-1 text-[0.8125rem]">
              {group.rules.map((rule, i) => (
                <li key={i}>{describeRule(rule, money)}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <footer className="flex items-center justify-end gap-3 border-t border-border px-5 py-3.5">
        {(error ?? refusal) !== null && (
          <p
            id={`${id}-refusal`}
            role={error !== null ? "alert" : undefined}
            className={cn(
              "min-w-0 flex-1 text-xs",
              error !== null ? "text-destructive" : "text-dim",
            )}
          >
            {error ?? refusal}
          </p>
        )}
        <button type="button" onClick={onClose} className={CONFIRM_CANCEL}>
          Cancel
        </button>
        <button
          type="button"
          // `NoteEditorDialog`'s two kinds of no: `pending` really is out of reach; an invalid
          // draft greys as the reader types, and a real `disabled` would throw the caret out of the
          // footer the moment their own edit made a rule incomplete.
          disabled={pending}
          aria-disabled={refusal !== null || undefined}
          aria-describedby={refusal !== null ? `${id}-refusal` : undefined}
          onClick={() => {
            if (refusal !== null) return;
            onSave(rows.map(toRule));
          }}
          className={META_SUBMIT_TYPED}
        >
          Save rules
        </button>
      </footer>
    </>
  );
}

/** The remove button's tooltip and name. */
function RemoveButton({ n, label, onRemove }: { n: number; label: string; onRemove: () => void }) {
  const tip = useTooltip();
  const name = `Remove rule ${n} (${label})`;
  return (
    <button
      type="button"
      onClick={onRemove}
      aria-label={name}
      {...tip(name, { describes: false })}
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-md text-dim hover:text-destructive",
        FOCUS,
      )}
    >
      <X className="size-4" aria-hidden="true" />
    </button>
  );
}

function RuleRow({
  row,
  n,
  currency,
  onChange,
  onRemove,
}: {
  row: Row;
  n: number;
  currency: string;
  onChange: (patch: Partial<Row>) => void;
  onRemove: () => void;
}) {
  const label = RULE_KIND_LABEL[row.kind];
  return (
    <li
      role="group"
      aria-label={`Rule ${n}: ${label}`}
      className="flex items-start gap-3 rounded-md border border-border p-2.5"
    >
      <span className="w-24 shrink-0 pt-1.5 text-[0.8125rem]">{label}</span>
      <div className="min-w-0 flex-1">
        <Editor row={row} currency={currency} onChange={onChange} />
      </div>
      <RemoveButton n={n} label={label} onRemove={onRemove} />
    </li>
  );
}

const BOX = cn(FIELD, "h-8 w-28 placeholder:text-dim");

/** Two boxes for a pair of ends. Blank is "no end", and says so with the placeholder. */
function Ends({
  row,
  names,
  captions,
  hint,
  inputMode,
  onChange,
}: {
  row: Row;
  names: [string, string];
  captions: [string, string];
  hint?: string;
  inputMode: "decimal" | "text";
  onChange: (patch: Partial<Row>) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-wrap items-end gap-3">
      {(["lo", "hi"] as const).map((end, i) => (
        <label key={end} className="flex flex-col gap-1 text-[0.6875rem] text-dim">
          {captions[i]}
          <input
            type="text"
            inputMode={inputMode}
            autoComplete="off"
            value={row[end]}
            placeholder="Any"
            aria-label={names[i]}
            aria-describedby={hint ? `${id}-hint` : undefined}
            onChange={(e) => onChange({ [end]: e.target.value })}
            className={BOX}
          />
        </label>
      ))}
      {hint && (
        <span id={`${id}-hint`} className="pb-2 text-[0.6875rem] text-dim">
          {hint}
        </span>
      )}
    </div>
  );
}

function Editor({
  row,
  currency,
  onChange,
}: {
  row: Row;
  currency: string;
  onChange: (patch: Partial<Row>) => void;
}) {
  const toggle = (value: string) =>
    onChange({
      values: row.values.includes(value)
        ? row.values.filter((v) => v !== value)
        : [...row.values, value],
    });

  switch (row.kind) {
    case "price":
      return (
        <Ends
          row={row}
          names={[`Minimum price in ${currency}`, `Maximum price in ${currency}`]}
          captions={[`Min (${currency})`, `Max (${currency})`]}
          inputMode="decimal"
          onChange={onChange}
        />
      );
    case "manaValue":
      return (
        <Ends
          row={row}
          names={["Minimum mana value", "Maximum mana value"]}
          captions={["Min", "Max"]}
          inputMode="decimal"
          onChange={onChange}
        />
      );
    case "released":
      return (
        <Ends
          row={row}
          names={["Released from", "Released to"]}
          captions={["From", "To"]}
          hint="YYYY, YYYY-MM or YYYY-MM-DD"
          inputMode="text"
          onChange={onChange}
        />
      );
    case "sets":
      return <SetsEditor values={row.values} onToggle={toggle} />;
    default:
      return <Chips kind={row.kind} values={row.values} onToggle={toggle} />;
  }
}

/** A chip per word of the kind's vocabulary — the filter bar's own chips, so a colour rule and a
 *  colour filter are one control to the eye. */
function Chips({
  kind,
  values,
  onToggle,
}: {
  kind: Exclude<ValuesRuleKind, "sets">;
  values: readonly string[];
  onToggle: (value: string) => void;
}) {
  return (
    <div
      role="group"
      aria-label={`${RULE_KIND_LABEL[kind]} values`}
      className="flex flex-wrap gap-1.5"
    >
      {RULE_VALUES[kind].map((value) => {
        const pressed = values.includes(value);
        const label = valueLabel(kind, value);
        if (kind === "colors") {
          return (
            <ManaChip
              key={value}
              symbol={value as ManaKey}
              pressed={pressed}
              onClick={() => onToggle(value)}
            />
          );
        }
        if (kind === "rarities") {
          return (
            <RarityChip
              key={value}
              rarity={value}
              title={label}
              pressed={pressed}
              onClick={() => onToggle(value)}
            />
          );
        }
        return (
          <ToggleChip key={value} label={label} pressed={pressed} onClick={() => onToggle(value)} />
        );
      })}
    </div>
  );
}

/**
 * The search's own set picker, plus the picked codes as chips that take themselves off.
 *
 * **The chips are not decoration**: `SetCombobox` offers the sets the corpus holds, so a rule
 * synced from a peer naming a set this device has not downloaded would otherwise hold a code the
 * reader can neither see nor remove.
 */
function SetsEditor({
  values,
  onToggle,
}: {
  values: readonly string[];
  onToggle: (code: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <SetCombobox selected={values} onToggle={onToggle} align="start" />
      {values.map((code) => (
        <button
          key={code}
          type="button"
          onClick={() => onToggle(code)}
          aria-label={`Remove set ${code.toUpperCase()}`}
          className={cn(
            "inline-flex h-7 items-center gap-1 rounded-full border border-border px-2.5 text-xs",
            "hover:border-accent",
            FOCUS,
          )}
        >
          {code.toUpperCase()}
          <X className="size-3" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
