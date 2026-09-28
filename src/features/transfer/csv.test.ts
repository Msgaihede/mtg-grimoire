import { describe, expect, it } from "vitest";
import { csvField, csvRow, parseCsv, readCsv } from "./csv";
import { escapeFormula } from "./formula";

describe("csvField", () => {
  it("leaves an ordinary value alone", () => {
    expect(csvField("Lightning Bolt")).toBe("Lightning Bolt");
  });

  it("quotes a value carrying a comma, a quote or a newline, and doubles an inner quote", () => {
    expect(csvField("Bolt, the")).toBe('"Bolt, the"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
  });
});

describe("csvRow", () => {
  it("joins fields with commas, quoting only what needs it", () => {
    expect(csvRow(["2", "Bolt, the", "LEA"])).toBe('2,"Bolt, the",LEA');
  });
});

describe("parseCsv", () => {
  it("reads a plain grid", () => {
    expect(parseCsv("Quantity,Name\n2,Lightning Bolt\n")).toEqual([
      ["Quantity", "Name"],
      ["2", "Lightning Bolt"],
    ]);
  });

  it("reads a quoted field carrying a comma", () => {
    expect(parseCsv('1,"Bolt, the"\n')).toEqual([["1", "Bolt, the"]]);
  });

  it("reads a doubled quote as one quote", () => {
    expect(parseCsv('1,"say ""hi"""\n')).toEqual([["1", 'say "hi"']]);
  });

  it("reads a newline inside a quoted field as part of the field", () => {
    expect(parseCsv('1,"two\nlines"\n')).toEqual([["1", "two\nlines"]]);
  });

  it("takes CRLF, and does not leave a stray carriage return in the last field", () => {
    expect(parseCsv("a,b\r\nc,d\r\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("drops a trailing blank line rather than reporting an empty row", () => {
    expect(parseCsv("a,b\n")).toEqual([["a", "b"]]);
    expect(parseCsv("a,b")).toEqual([["a", "b"]]);
  });

  it("keeps an empty field as an empty string", () => {
    expect(parseCsv("a,,c\n")).toEqual([["a", "", "c"]]);
  });

  it("is the inverse of csvRow for every shape csvField can produce", () => {
    const values = ["plain", "with, comma", 'with "quote"', "with\nnewline", ""];
    expect(parseCsv(csvRow(values) + "\n")).toEqual([values]);
  });

  it("splits on the separator it is given, and a comma is then just a character", () => {
    expect(parseCsv("2;Aragorn, the Uniter;4,50\n", ";")).toEqual([
      ["2", "Aragorn, the Uniter", "4,50"],
    ]);
    expect(parseCsv("2\tLightning Bolt\n", "\t")).toEqual([["2", "Lightning Bolt"]]);
  });

  /** The bare grid undoes nothing: the escape belongs to a *file*, which is `readCsv`'s. */
  it("leaves a formula escape where it found it", () => {
    expect(parseCsv("'=SUM(A1)\n")).toEqual([["'=SUM(A1)"]]);
  });
});

describe("readCsv", () => {
  it("says which physical line each row starts on, past a cell that spans three", () => {
    const { records } = readCsv('Quantity,Name,Notes\n1,Sol Ring,"one\ntwo\nthree"\n2,Shock,\n');
    expect(records.map((r) => r.line)).toEqual([1, 2, 5]);
    expect(records[1].cells[2]).toBe("one\ntwo\nthree");
  });

  /** The three breaks `parse.ts`' per-line reader splits on, inside a quoted cell as well as
   *  between rows — CRLF once, a lone CR once — so the two readers agree what a line is. */
  it("counts CRLF once and a lone carriage return once, inside a cell and out", () => {
    const { records } = readCsv('a,"x\r\ny\rz"\r\nb,c\rd,e');
    expect(records.map((r) => [r.cells[0], r.line])).toEqual([
      ["a", 1],
      ["b", 4],
      ["d", 5],
    ]);
  });

  it("keeps each row's own text, quotes and all, for the preview to quote back", () => {
    const { records } = readCsv('Quantity,Name\n1,"Aragorn, the Uniter"\r\n');
    expect(records[1].raw).toBe('1,"Aragorn, the Uniter"');
  });

  it("takes a byte-order mark off the first header cell", () => {
    const { records } = readCsv("﻿Quantity,Name\n1,Sol Ring\n");
    expect(records[0]).toMatchObject({ cells: ["Quantity", "Name"], line: 1 });
  });

  /** Dragon Shield's real export opens on `"sep=,"`, quotes included; Excel writes it bare. The
   *  line is gone from the rows and still counted, so the header is where an editor shows it. */
  it("strips a sep= line, quoted or bare, and still counts it as line one", () => {
    for (const first of ['"sep=,"', "sep=,"]) {
      const { delimiter, records } = readCsv(`${first}\r\nQuantity,Name\r\n1,Sol Ring\r\n`);
      expect(delimiter, first).toBe(",");
      expect(records.map((r) => [r.cells, r.line]), first).toEqual([
        [["Quantity", "Name"], 2],
        [["1", "Sol Ring"], 3],
      ]);
    }
  });

  it("uses the separator a sep= line declares, whatever the header would have voted", () => {
    const { delimiter, records } = readCsv("sep=;\nName,Notes;Quantity\nSol Ring,a;1\n");
    expect(delimiter).toBe(";");
    expect(records[0].cells).toEqual(["Name,Notes", "Quantity"]);
  });

  it("measures a semicolon file, and a tab file, off the header line", () => {
    const semi = readCsv("Quantity;Name;Purchase price\n2;Aragorn, the Uniter;4,50\n");
    expect(semi.delimiter).toBe(";");
    expect(semi.records[1].cells).toEqual(["2", "Aragorn, the Uniter", "4,50"]);

    const tab = readCsv("Quantity\tName\n2\tLightning Bolt\n");
    expect(tab.delimiter).toBe("\t");
    expect(tab.records[1].cells).toEqual(["2", "Lightning Bolt"]);
  });

  /** A quoted comma is inside a cell, so it is not a vote — and the comma wins every tie, which
   *  is what keeps a one-column file and every decklist reading exactly as they always did. */
  it("counts only separators outside quotes, and gives the comma every tie", () => {
    expect(readCsv('"Name, first";"Set, code";Quantity\n').delimiter).toBe(";");
    expect(readCsv("Name,Notes;x\n").delimiter).toBe(",");
    expect(readCsv("4 Lightning Bolt\n1 Sol Ring\n").delimiter).toBe(",");
    expect(readCsv("").records).toEqual([]);
  });

  /** `formula.ts`' writer puts one apostrophe in front of anything a spreadsheet would
   *  evaluate; this is the half that takes it back off, on every cell, header included. */
  it("takes the formula escape off every cell, and only that escape", () => {
    const { records } = readCsv("Name,'=Notes\nSol Ring,'-2 lent to Sam\nShock,''=x\nBolt,'hi\n");
    expect(records[0].cells).toEqual(["Name", "=Notes"]);
    expect(records.slice(1).map((r) => r.cells[1])).toEqual(["-2 lent to Sam", "'=x", "'hi"]);
  });

  /** The fixed point the escape exists to keep: whatever the writer escapes, this gives back as
   *  the reader typed it — including a note that already opened on an apostrophe. */
  it("reads back exactly what escapeFormula and csvRow wrote", () => {
    const values = ["=SUM(A1)", "+1", "-2 lent, to Sam", "@home", "'=already", "'hi", "plain"];
    const rows = values.map((v) => csvRow(["Sol Ring", escapeFormula(v)]));
    const text = `Name,Notes\n${rows.join("\n")}\n`;
    expect(readCsv(text).records.slice(1).map((r) => r.cells[1])).toEqual(values);
  });
});
