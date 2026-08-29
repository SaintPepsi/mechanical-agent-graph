import { describe, expect, test } from "bun:test"
import { backtickedNames, caseVariants, HIT_CAP, hitsIn, renderScan } from "mag/graph-nodes/recycle-scan/scan"

describe("backtickedNames", () => {
  test("every backticked span without whitespace, once each, in order of first appearance", () => {
    const design = "Use `graph-node.definition.ts` and `journaled`; `journaled` again, `not an identifier`, and ``."
    expect(backtickedNames(design)).toEqual(["graph-node.definition.ts", "journaled"])
  })

  test("a span broken across lines is not a name", () => {
    expect(backtickedNames("`foo\nbar`")).toEqual([])
  })
})

describe("caseVariants", () => {
  test("a kebab name yields itself, camel and snake", () => {
    expect(caseVariants("recycle-scan")).toEqual(["recycle-scan", "recycleScan", "recycle_scan"])
  })

  test("a camel name splits on its own boundaries", () => {
    expect(caseVariants("recycleScanPath")).toEqual(["recycleScanPath", "recycle-scan-path", "recycle_scan_path"])
  })

  test("a single word is one spelling", () => {
    expect(caseVariants("plan")).toEqual(["plan"])
  })

  test("a name with no word at all is searched as written", () => {
    expect(caseVariants("---")).toEqual(["---"])
  })
})

describe("hitsIn", () => {
  test("a path carrying a variant is a hit without a line; each matching line is a hit with its 1-based number", () => {
    const hits = hitsIn("src/recycle-scan/scan.ts", "const recycleScan = 1\nnothing\nrecycle_scan()\n", caseVariants("recycle-scan"))
    expect(hits).toEqual([{ path: "src/recycle-scan/scan.ts" }, { path: "src/recycle-scan/scan.ts", line: 1 }, { path: "src/recycle-scan/scan.ts", line: 3 }])
  })

  test("no variant anywhere is no hit", () => {
    expect(hitsIn("src/other.ts", "x\n", caseVariants("recycle-scan"))).toEqual([])
  })
})

describe("renderScan", () => {
  test("one row per hit, a none row for a name without one, and a count row past the cap", () => {
    const many = Array.from({ length: HIT_CAP + 3 }, (_, index) => ({ path: "a.ts", line: index + 1 }))
    const rendered = renderScan("/run/design.md", [
      { name: "foo", hits: [{ path: "foo.ts" }, { path: "bar.ts", line: 4 }] },
      { name: "gone", hits: [] },
      { name: "busy", hits: many }
    ])
    expect(rendered).toContain("| `foo` | foo.ts |\n| `foo` | bar.ts:4 |")
    expect(rendered).toContain("| `gone` | none |")
    expect(rendered.split("| `busy` |").length - 1).toBe(HIT_CAP + 1)
    expect(rendered).toContain("| `busy` | +3 more |")
    expect(rendered).toContain("/run/design.md")
  })
})
