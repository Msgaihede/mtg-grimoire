/**
 * The scanner's shapes, re-exported from the one place the frontend mirrors a Rust struct.
 *
 * They live in `@/lib/ipc` like every other DTO in this app — that is the file `ipc.test.ts`'s
 * mirror rows read, so a field renamed in `crates/card-scanner` goes red there. This module is
 * the feature's own name for them, so nothing under `features/scanner/` reaches across to the
 * IPC boundary for a type.
 */
export type {
  ScannerMethod,
  ScannerRule,
  ScannerOptions,
  ScannerAsset,
  ScannerStatus,
  ScannerSidecar,
  ScannerCaptured,
  ScannerFrameSize,
  ScannerLockPhase,
  ScannerLock,
  ScannerCorner,
  ScannerScore,
  ScannerTimings,
  ScannerCardness,
  ScannerTrim,
  ScannerStages,
  ScannerLabel,
  ScannerCandidate,
  ScannerMatch,
  ScannerStanding,
  ScannerTracked,
  ScannerCollectorTry,
  ScannerCollector,
  ScannerOcr,
  ScannerVerdict,
} from "@/lib/ipc";
