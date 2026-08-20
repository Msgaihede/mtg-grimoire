import { describe, expect, it } from "vitest";
import { csvField, csvRow, parseCsv } from "./csv";

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
});
