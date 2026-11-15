"""Read copy-audit.xlsx (as edited in Excel) and print its rows as JSON.

Standard library only. Usage:
    python copy_audit_to_json.py copy-audit.xlsx            # every row
    python copy_audit_to_json.py copy-audit.xlsx --changed  # only rows where New differs from Existing
    python copy_audit_to_json.py copy-audit.xlsx --changed -o changes.json

Each row: {"id", "where", "type", "existing", "new", "note", "component", "file", "line"}.
A blank "New suggestion" cell counts as "keep the existing text".
"""
import argparse, json, re, sys, zipfile
import xml.etree.ElementTree as ET

NS = {
    "m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "pr": "http://schemas.openxmlformats.org/package/2006/relationships",
}
HEADERS = {
    "ID": "id",
    "Where": "where",
    "Type": "type",
    "Existing text": "existing",
    "New suggestion": "new",
    "Note": "note",
    "Component": "component",
    "Source": "source",
}


def text_of(el):
    """Concatenate every <t> under an <si> or <is> (plain or rich-text runs)."""
    return "".join(t.text or "" for t in el.iter(f"{{{NS['m']}}}t"))


def col_index(ref):
    letters = re.match(r"[A-Z]+", ref).group(0)
    n = 0
    for ch in letters:
        n = n * 26 + ord(ch) - 64
    return n


def read(path, sheet_name="Copy"):
    with zipfile.ZipFile(path) as z:
        wb = ET.fromstring(z.read("xl/workbook.xml"))
        rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
        target = None
        for s in wb.find("m:sheets", NS):
            if s.get("name") == sheet_name:
                rid = s.get(f"{{{NS['r']}}}id")
                for rel in rels:
                    if rel.get("Id") == rid:
                        target = rel.get("Target").lstrip("/")
        if target is None:
            sys.exit(f"no sheet named {sheet_name!r}")
        if not target.startswith("xl/"):
            target = "xl/" + target
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            sst = ET.fromstring(z.read("xl/sharedStrings.xml"))
            shared = [text_of(si) for si in sst.findall("m:si", NS)]
        ws = ET.fromstring(z.read(target))

    grid = []
    for row in ws.find("m:sheetData", NS).findall("m:row", NS):
        vals = {}
        for c in row.findall("m:c", NS):
            t = c.get("t")
            if t == "inlineStr":
                is_ = c.find("m:is", NS)
                v = text_of(is_) if is_ is not None else ""
            else:
                v_el = c.find("m:v", NS)
                v = v_el.text if v_el is not None and v_el.text is not None else ""
                if t == "s" and v != "":
                    v = shared[int(v)]
            vals[col_index(c.get("r"))] = v
        grid.append(vals)

    header = grid[0]
    cols = {HEADERS[name]: idx for idx, name in header.items() if name in HEADERS}
    missing = [h for h in ("id", "existing", "new", "source") if h not in cols]
    if missing:
        sys.exit(f"header row is missing columns: {missing}")
    out = []
    for vals in grid[1:]:
        rec = {k: vals.get(i, "") for k, i in cols.items()}
        if not rec["id"]:
            continue
        if rec["new"] == "":
            rec["new"] = rec["existing"]
        file, _, line = rec.pop("source").rpartition(":")
        rec["file"], rec["line"] = file, int(line) if line.isdigit() else None
        out.append(rec)
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("xlsx")
    ap.add_argument("--changed", action="store_true", help="only rows whose New differs from Existing")
    ap.add_argument("-o", "--output", help="write JSON here instead of stdout")
    a = ap.parse_args()
    rows = read(a.xlsx)
    if a.changed:
        rows = [r for r in rows if r["new"] != r["existing"]]
    text = json.dumps(rows, ensure_ascii=False, indent=1)
    if a.output:
        with open(a.output, "w", encoding="utf8") as f:
            f.write(text)
        print(f"{len(rows)} rows -> {a.output}", file=sys.stderr)
    else:
        sys.stdout.reconfigure(encoding="utf8")
        print(text)
