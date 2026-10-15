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
 *
 * **Rules combine with AND and OR through groups** (issue #1053): the folder's own list is an AND,
 * and `Add rule` also offers a group — "all of" (AND) or "any of" (OR) — that holds rules and
 * groups of its own, up to `MAX_GROUP_DEPTH` deep. "Rare or full art and land" is an `any of`
 * holding `Rarity` and an `all of` holding `Border` and `Card type`. A group's join is a picker on
 * its header, so turning an AND into an OR never rebuilds what is inside it.
 */
import { useId, useState, type ReactElement } from "react";
import { Brackets, Plus, X } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import { ManaChip, RarityChip, ToggleChip } from "@/components/FilterChips";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { CONFIRM_CANCEL, META_SUBMIT_TYPED } from "@/features/decks/metaRows";
import { FIELD } from "@/features/decks/formFields";
import { SetCombobox } from "@/features/search/SetCombobox";
import {
  countRules,
  describeRule,
  kindsFor,
  MAX_GROUP_DEPTH,
  MAX_RULES,
  RULE_KIND_LABEL,
  RULE_OP_LABEL,
  RULE_VALUES,
  validateRules,
  valueLabel,
  type InheritedRules,
  type ValuesRuleKind,
} from "@/lib/folderRules";
import { FOCUS } from "@/lib/focus";
import type { FolderRule, FolderRuleKind, FolderRuleOp } from "@/lib/ipc";
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
      subtitle="Cards filed here should match every rule — group rules to match any of them instead. Nothing is refused for breaking one — it is outlined in red."
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
interface LeafRow {
  key: number;
  kind: FolderRuleKind;
  /** `min` / `from`. */
  lo: string;
  /** `max` / `to`. */
  hi: string;
  values: string[];
}

/** A group as the reader is editing it — its join and its members, which may be groups. */
interface GroupRow {
  key: number;
  kind: "group";
  op: FolderRuleOp;
  rows: Row[];
}

type Row = LeafRow | GroupRow;

/**
 * A row's React key. **Module-wide rather than per dialog**: a key only has to be unique among
 * one list's siblings, and a counter that never repeats is that across every group of every
 * draft without a ref read during render to seed it.
 */
let lastKey = 0;
const freshKey = (): number => (lastKey += 1);

function toRow(rule: FolderRule): Row {
  const key = freshKey();
  switch (rule.kind) {
    case "group":
      return { key, kind: "group", op: rule.op, rows: rule.rules.map(toRow) };
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
    case "group":
      return { kind: "group", op: row.op, rules: row.rows.map(toRule) };
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

/** Whether a range box anywhere in `rows` holds text that is not a number. */
function unparsed(rows: readonly Row[]): boolean {
  return rows.some((r) =>
    r.kind === "group"
      ? unparsed(r.rows)
      : (r.kind === "price" || r.kind === "manaValue") &&
        [r.lo, r.hi].some((t) => Number.isNaN(parseEnd(t))),
  );
}

/** The first reason Save is out of reach, or `null`. A box that is not a number is said first,
 *  because `validateRules` would read its `NaN` as a range with no lower end. */
function draftRefusal(rows: readonly Row[]): string | null {
  if (unparsed(rows)) return NOT_A_NUMBER;
  return validateRules(rows.map(toRule));
}

/** `rows` with the row keyed `key` replaced by what `change` makes of it — or taken out, for
 *  `null` — wherever in the tree it sits. */
function changeRow(rows: readonly Row[], key: number, change: (row: Row) => Row | null): Row[] {
  return rows.flatMap((r) => {
    if (r.key === key) {
      const next = change(r);
      return next === null ? [] : [next];
    }
    return r.kind === "group" ? [{ ...r, rows: changeRow(r.rows, key, change) }] : [r];
  });
}

/** What the `Add rule` picker answers for a group, beside the kinds. */
const ADD_GROUP: Record<FolderRuleOp, string> = { or: "group:or", and: "group:and" };

/** The draft's edits, handed down the tree so a group's members edit the one draft. */
interface Edits {
  scope: "collection" | "wishlist";
  currency: string;
  /** No rule may be added anywhere: the draft holds {@link MAX_RULES}. */
  full: boolean;
  /** Append a fresh row to the group keyed `parent`, or to the folder's own list for `null`. */
  add: (parent: number | null, row: Row) => void;
  change: (key: number, change: (row: Row) => Row | null) => void;
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
  const [rows, setRows] = useState<Row[]>(() => rules.map(toRow));

  const refusal = draftRefusal(rows);
  const edits: Edits = {
    scope,
    currency: marketplace.currency.toUpperCase(),
    full: countRules(rows.map(toRule)) >= MAX_RULES,
    add: (parent, row) =>
      setRows((rs) =>
        parent === null
          ? [...rs, row]
          : changeRow(rs, parent, (g) =>
              g.kind === "group" ? { ...g, rows: [...g.rows, row] } : g,
            ),
      ),
    change: (key, change) => setRows((rs) => changeRow(rs, key, change)),
  };

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
        {rows.length === 0 ? (
          <p className="text-sm text-dim">
            No rules of its own. Add one, and every card filed here is checked against it.
          </p>
        ) : (
          <RowList rows={rows} op="and" path="" edits={edits} />
        )}

        <AddRule parent={null} depth={0} label="Add rule" edits={edits} />

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

/**
 * The `Add rule` picker: every kind the page offers, then — while there is room to nest — the two
 * groups. `depth` is how many groups the new row would sit inside.
 */
function AddRule({
  parent,
  depth,
  label,
  edits,
}: {
  parent: number | null;
  depth: number;
  label: string;
  edits: Edits;
}) {
  const kinds = kindsFor(edits.scope);
  const groups = depth < MAX_GROUP_DEPTH ? (["or", "and"] as const) : [];
  const add = (value: string) => {
    const op = groups.find((o) => ADD_GROUP[o] === value);
    if (op !== undefined) {
      edits.add(parent, { key: freshKey(), kind: "group", op, rows: [] });
      return;
    }
    const kind = kinds.find((k) => k === value);
    if (kind === undefined) return;
    edits.add(parent, { key: freshKey(), kind, lo: "", hi: "", values: [] });
  };
  return (
    <div className="flex items-center gap-2">
      <Dropdown
        label={edits.full ? `${label} (at most ${MAX_RULES})` : label}
        placeholder="Add rule"
        value=""
        size="sm"
        align="start"
        disabled={edits.full}
        options={[
          ...kinds.map((k) => ({
            value: k,
            label: RULE_KIND_LABEL[k],
            icon: <Plus className="size-3.5" aria-hidden="true" />,
          })),
          ...groups.map((op) => ({
            value: ADD_GROUP[op],
            label: `Group: ${RULE_OP_LABEL[op].toLowerCase()}`,
            hint: op.toUpperCase(),
            icon: <Brackets className="size-3.5" aria-hidden="true" />,
          })),
        ]}
        onChange={add}
      />
    </div>
  );
}

/**
 * One list of rows — the folder's own, or a group's members — with the word that joins them drawn
 * between each pair. `path` is the list's number (`""` for the folder's, `"2."` inside its second
 * row), so a member is named `Rule 2.1` and a reader hears where it sits.
 */
function RowList({
  rows,
  op,
  path,
  depth = 0,
  edits,
}: {
  rows: readonly Row[];
  op: FolderRuleOp;
  path: string;
  depth?: number;
  edits: Edits;
}) {
  return (
    <ol className="flex flex-col gap-1.5">
      {rows.map((row, i) => (
        <li key={row.key} className="flex flex-col gap-1.5">
          {i > 0 && (
            // The join is said by the group's own name ("any of"); this is for the eye.
            <span
              aria-hidden="true"
              className="pl-2.5 text-[0.6875rem] font-medium uppercase tracking-wide text-dim"
            >
              {op}
            </span>
          )}
          {row.kind === "group" ? (
            <GroupBox group={row} n={`${path}${i + 1}`} depth={depth + 1} edits={edits} />
          ) : (
            <RuleRow
              row={row}
              n={`${path}${i + 1}`}
              currency={edits.currency}
              onChange={(patch) =>
                edits.change(row.key, (r) => (r.kind === "group" ? r : { ...r, ...patch }))
              }
              onRemove={() => edits.change(row.key, () => null)}
            />
          )}
        </li>
      ))}
    </ol>
  );
}

/** A group: its join, its members, an `Add rule` of its own, and a remove for the whole group. */
function GroupBox({
  group,
  n,
  depth,
  edits,
}: {
  group: GroupRow;
  n: string;
  depth: number;
  edits: Edits;
}) {
  const opLabel = RULE_OP_LABEL[group.op].toLowerCase();
  return (
    <div
      role="group"
      aria-label={`Group ${n}: ${opLabel}`}
      className="flex flex-col gap-2 rounded-md border border-dashed border-border p-2.5"
    >
      <div className="flex items-center gap-3">
        <Dropdown
          label={`Join of group ${n}`}
          value={group.op}
          size="sm"
          align="start"
          options={(["and", "or"] as const).map((op) => ({
            value: op,
            label: `${RULE_OP_LABEL[op]} these`,
            hint: op.toUpperCase(),
          }))}
          onChange={(value) => {
            const op = (["and", "or"] as const).find((o) => o === value);
            if (op === undefined) return;
            edits.change(group.key, (r) => (r.kind === "group" ? { ...r, op } : r));
          }}
        />
        <span className="min-w-0 flex-1" />
        <RemoveButton
          name={`Remove group ${n} (${opLabel})`}
          onRemove={() => edits.change(group.key, () => null)}
        />
      </div>
      {group.rows.length === 0 ? (
        <p className="text-xs text-dim">Empty — add the rules this group joins.</p>
      ) : (
        <RowList rows={group.rows} op={group.op} path={`${n}.`} depth={depth} edits={edits} />
      )}
      <AddRule parent={group.key} depth={depth} label={`Add rule to group ${n}`} edits={edits} />
    </div>
  );
}

/** The remove button's tooltip and name. */
function RemoveButton({ name, onRemove }: { name: string; onRemove: () => void }) {
  const tip = useTooltip();
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
  row: LeafRow;
  n: string;
  currency: string;
  onChange: (patch: Partial<LeafRow>) => void;
  onRemove: () => void;
}) {
  const label = RULE_KIND_LABEL[row.kind];
  return (
    <div
      role="group"
      aria-label={`Rule ${n}: ${label}`}
      className="flex items-start gap-3 rounded-md border border-border p-2.5"
    >
      <span className="w-24 shrink-0 pt-1.5 text-[0.8125rem]">{label}</span>
      <div className="min-w-0 flex-1">
        <Editor row={row} currency={currency} onChange={onChange} />
      </div>
      <RemoveButton name={`Remove rule ${n} (${label})`} onRemove={onRemove} />
    </div>
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
  row: LeafRow;
  names: [string, string];
  captions: [string, string];
  hint?: string;
  inputMode: "decimal" | "text";
  onChange: (patch: Partial<LeafRow>) => void;
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
  row: LeafRow;
  currency: string;
  onChange: (patch: Partial<LeafRow>) => void;
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
