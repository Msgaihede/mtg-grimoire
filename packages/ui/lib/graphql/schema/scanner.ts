/**
 * The graph's half of `lib/ipc/scanner.ts`: the review tray — the cards scanned and not yet
 * added, which the home page's To review widget counts.
 */
import { FINISHES } from "@/lib/finish";
import type { ScannerTrayChoice, ScannerTrayFinish, ScannerTrayRow } from "@/lib/ipc";
import { ipc } from "@/lib/ipc";
import { builder, invalidatedBy } from "../builder";

const TRAY_FINISHES = [...FINISHES, "unknown"] as const satisfies readonly ScannerTrayFinish[];

const ScannerTrayFinishEnum = builder.enumType("ScannerTrayFinish", {
  description: "A tray row's finish — a printing's, or `unknown` until the reader says.",
  values: TRAY_FINISHES,
});

const ScannerTrayChoiceRef = builder.objectRef<ScannerTrayChoice>("ScannerTrayChoice").implement({
  description: "One printing a tray row could be.",
  fields: (t) => ({
    cardId: t.exposeString("cardId"),
    oracleId: t.exposeString("oracleId", { nullable: true }),
    name: t.exposeString("name"),
    setCode: t.exposeString("setCode"),
    collectorNumber: t.exposeString("collectorNumber"),
    finishes: t.exposeStringList("finishes", {
      nullable: true,
      description: "The finishes the printing exists in. Absent when unknown.",
    }),
  }),
});

const ScannerTrayRowRef = builder.objectRef<ScannerTrayRow>("ScannerTrayRow").implement({
  description: "A card the scanner read and the reader has not yet added to the collection.",
  fields: (t) => ({
    key: t.exposeString("key"),
    cardId: t.exposeString("cardId"),
    oracleId: t.exposeString("oracleId", { nullable: true }),
    name: t.exposeString("name"),
    setCode: t.exposeString("setCode"),
    collectorNumber: t.exposeString("collectorNumber"),
    finish: t.expose("finish", { type: ScannerTrayFinishEnum }),
    finishes: t.exposeStringList("finishes", { nullable: true }),
    quantity: t.exposeInt("quantity"),
    choices: t.expose("choices", { type: [ScannerTrayChoiceRef] }),
    addedAt: t.exposeFloat("addedAt", {
      description: "When it was scanned, in Unix milliseconds.",
    }),
  }),
});

builder.queryFields((t) => ({
  scannerTray: t.field({
    ...invalidatedBy("scanner"),
    description: "The scanner's review tray, in the order it was scanned.",
    type: [ScannerTrayRowRef],
    resolve: () => ipc.scannerTray(),
  }),
}));
