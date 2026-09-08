import type { ScannerRule, ScannerStatus, ScannerVerdict } from "../types";
import { modelsSentence, standingValue } from "../verdictText";
import { FIGURES, Panel, Row } from "./Panel";

/** A band the recogniser read from, or the space one would have taken. */
function Band({ src, alt }: { src: string | null; alt: string }) {
  return src === null ? (
    <div className="grid h-9 place-items-center rounded bg-bg text-xs text-dim">nothing read</div>
  ) : (
    <img src={src} alt={alt} className="w-full rounded bg-bg" />
  );
}

/** A heading inside the panel — the two tiers are two readouts, not one list of figures. */
function Tier({ children }: { children: string }) {
  return <h3 className="text-xs uppercase tracking-wide text-dim">{children}</h3>;
}

/**
 * What the two OCR tiers read, and what each turned it into.
 *
 * **The tiers answer different questions and that is why both are here.** The title band names
 * the *card*; the collector line names the *printing*, which no amount of reading the title can
 * do. So a frame can know what it is looking at and still not know which printing — the
 * pairings list below is where that shows, one attempted set/number per row.
 *
 * A missing model is said once, at the top, rather than as six em dashes a reader has to
 * interpret: the tiers stand down when the `.rten` files are not there, and every figure being
 * blank is the *consequence* rather than the news.
 */
export function ReadoutsPanel({
  status,
  verdict,
  rule,
}: {
  status: ScannerStatus | null;
  verdict: ScannerVerdict | null;
  /** How the standings below are valued — votes read as a tally, confidence as a share. */
  rule: ScannerRule;
}) {
  const noModels = modelsSentence(status);
  const ocr = verdict?.ocr ?? null;
  const collector = verdict?.collector ?? null;
  const lead = verdict?.tracked?.standings[0] ?? null;

  return (
    <Panel id="readouts" title="Readouts">
      {noModels !== null && <p className="text-sm text-destructive">{noModels}</p>}

      <Tier>title band</Tier>
      <Band src={ocr?.band ?? null} alt="the crop the recogniser read the title from" />
      <dl className={FIGURES}>
        <Row label="raw" value={ocr === null ? "—" : ocr.raw || "(nothing read)"} />
        <Row label="normalized" value={ocr === null ? "—" : ocr.normalized || "(nothing read)"} />
        <Row
          label="rotated"
          value={ocr === null ? "—" : ocr.rotated ? "rotated 180°" : "upright"}
        />
        <Row label="elapsed" value={ocr === null ? "—" : `${ocr.elapsed_ms.toFixed(0)} ms`} />
        <Row label="matched" value={ocr === null ? "—" : (ocr.matched ?? "no name")} />
        <Row label="edits" value={ocr?.edits == null ? "—" : String(ocr.edits)} />
      </dl>

      <Tier>collector band</Tier>
      <Band
        src={collector?.band ?? null}
        alt="the crop the recogniser read the collector line from"
      />
      <dl className={FIGURES}>
        <Row label="raw" value={collector === null ? "—" : collector.raw || "(nothing read)"} />
        <Row
          label="matched"
          value={collector === null ? "—" : (collector.matched ?? "no printing")}
        />
      </dl>

      {collector !== null && collector.tried.length > 0 && (
        <ul className="space-y-0.5 text-xs text-dim">
          {collector.tried.map((t) => (
            <li key={`${t.set}-${t.number}`}>
              {`${t.set.toUpperCase()} ${t.number} → ${t.matched ?? "—"}`}
            </li>
          ))}
        </ul>
      )}
      {/* The cap is the crate's, at fourteen. Saying how many were dropped is what tells a
          long list from a truncated one — a noisy read produces dozens. */}
      {collector !== null && collector.more > 0 && (
        <p className="text-xs text-dim">{`+${collector.more} more pairings not shown`}</p>
      )}

      {/* The one line that is neither tier's: what the *appearance* match is standing on while
          the two above are still arguing. Valued by the rule in force, so it reads in the same
          units as the standings in the Match panel. */}
      {lead !== null && (
        <p className="text-xs text-dim">
          {`appearance: ${lead.label?.name ?? lead.id} · ${standingValue(lead, rule)}`}
        </p>
      )}
    </Panel>
  );
}
