import { existsSync } from "node:fs"
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import {
  carriesUnimplementedMarker,
  DEFAULT_GRAPH_NODES_ROOT,
  EXAMPLE_EXPORTS,
  importSpecifiers,
  isAllowedImport,
  LOADED_FILES,
  nodeInternalTarget,
  REQUIRED_FILES,
  REQUIRED_NODE_FIELDS,
  TEST_SUPPORT_MODULES,
  UNIMPLEMENTED_MARKER,
} from "mag/runtime/graph-node.shape"

describe("REQUIRED_FILES / LOADED_FILES", () => {
  test("LOADED_FILES is graph-node.ts, errors.ts, examples.ts", () => {
    expect(LOADED_FILES).toEqual(["graph-node.ts", "errors.ts", "examples.ts"])
  })

  test("REQUIRED_FILES still contains graph-node.test.ts", () => {
    expect(REQUIRED_FILES.includes("graph-node.test.ts")).toBe(true)
  })
})

describe("data tables", () => {
  test("REQUIRED_NODE_FIELDS names the GraphNode contract fields", () => {
    expect(REQUIRED_NODE_FIELDS).toEqual(["name", "description", "input", "success", "run"])
  })

  test("EXAMPLE_EXPORTS names the fixture exports", () => {
    expect(EXAMPLE_EXPORTS).toEqual(["inputExamples", "successExamples"])
  })

  test("TEST_SUPPORT_MODULES is exactly the node-fixture module", () => {
    expect(TEST_SUPPORT_MODULES).toEqual(["mag/test/node-fixture"])
  })

  test("UNIMPLEMENTED_MARKER is the literal scaffold marker string", () => {
    expect(UNIMPLEMENTED_MARKER).toBe("GRAPH_NODE_UNIMPLEMENTED")
  })
})

describe("DEFAULT_GRAPH_NODES_ROOT", () => {
  test("ends with src/graph-nodes and exists on disk", () => {
    expect(DEFAULT_GRAPH_NODES_ROOT.endsWith("src/graph-nodes")).toBe(true)
    expect(existsSync(DEFAULT_GRAPH_NODES_ROOT)).toBe(true)
  })
})

describe("importSpecifiers", () => {
  test("extracts from import x from \"a\"", () => {
    expect(importSpecifiers('import x from "a"')).toEqual(["a"])
  })

  test("extracts from import {y} from \"b\"", () => {
    expect(importSpecifiers('import { y } from "b"')).toEqual(["b"])
  })

  test("extracts from bare import \"c\"", () => {
    expect(importSpecifiers('import "c"')).toEqual(["c"])
  })

  test("extracts from export * from \"d\"", () => {
    expect(importSpecifiers('export * from "d"')).toEqual(["d"])
  })

  test("extracts from export {e} from \"f\"", () => {
    expect(importSpecifiers('export { e } from "f"')).toEqual(["f"])
  })

  test("extracts from await import(\"g\")", () => {
    expect(importSpecifiers('await import("g")')).toEqual(["g"])
  })

  test("extracts from const {x} = require(\"h\")", () => {
    expect(importSpecifiers('const { x } = require("h")')).toEqual(["h"])
  })

  test("extracts single-quoted forms", () => {
    expect(importSpecifiers("import x from 'a'")).toEqual(["a"])
    expect(importSpecifiers("import 'c'")).toEqual(["c"])
    expect(importSpecifiers("await import('g')")).toEqual(["g"])
  })

  test("extracts multiple specifiers from a multi-line source", () => {
    const source = [
      'import { Effect } from "effect"',
      'import { make } from "mag/runtime/graph-node.definition"',
      'export { helper } from "./helper"',
      'const x = await import("node:path")',
    ].join("\n")

    expect(importSpecifiers(source)).toEqual([
      "effect",
      "mag/runtime/graph-node.definition",
      "./helper",
      "node:path",
    ])
  })

  test("returns an empty array when there are no imports", () => {
    expect(importSpecifiers("const x = 1")).toEqual([])
  })

  test("ignores an import-shaped phrase inside a string literal", () => {
    expect(importSpecifiers("description: \"translate the phrase: import fs from 'fs' in docs\"")).toEqual([])
  })

  test("ignores imports inside comments", () => {
    expect(importSpecifiers('// import "zod"\n/* export * from "left-pad" */\nconst x = 1')).toEqual([])
  })

  test("ignores Array.from(\"abc\"), a method call, not a from clause", () => {
    expect(importSpecifiers('const chars = Array.from("abc")')).toEqual([])
  })

  test("an apostrophe in a comment does not desync the scan", () => {
    expect(importSpecifiers("// it's tricky\nimport \"a\"")).toEqual(["a"])
  })

  test("a regex literal containing quotes does not swallow a following import", () => {
    expect(importSpecifiers("const q = /[\"']/\nimport \"a\"")).toEqual(["a"])
  })

  test("division is not mistaken for a regex opening", () => {
    expect(importSpecifiers('const half = total / 2\nimport "a"')).toEqual(["a"])
  })
})

describe("isAllowedImport", () => {
  const nodeName = "conformance"

  test.each([
    ["effect", true],
    ["effect/unstable/cli", true],
    ["node:path", true],
    ["bun:test", true],
    ["mag/runtime/graph-node.shape", true],
    ["mag/runtime/anything/nested", true],
    ["mag/graph-nodes/conformance/errors", true],
    ["mag/test/node-fixture", true],
    // Skills are an audited shared seam, same treatment as `mag/runtime` — a node compiles a
    // skill variant inside its own runtime rather than owning a copy of it.
    ["mag/skills", true],
    ["mag/skills/installed", true],
  ])("allows %s", (specifier, expected) => {
    expect(isAllowedImport(specifier, nodeName)).toBe(expected)
  })

  test.each([
    ["mag/graph-nodes/other/helper", false],
    ["./examples", false],
    ["../runtime/x", false],
    ["mag/registry", false],
    ["mag/skillsx", false],
    ["@effect/platform-node", false],
    ["zod", false],
  ])("rejects %s", (specifier, expected) => {
    expect(isAllowedImport(specifier, nodeName)).toBe(expected)
  })

  // "Same behaviour, one home" — selfSpecifier backs this row; every form the allowlist covers
  // must resolve identically.
  test.each([
    ["mag/graph-nodes/conformance/errors", true],
    ["mag/graph-nodes/conformance", true],
    ["mag/graph-nodes/other/helper", false],
    ["./examples", false],
    ["../runtime/x", false],
  ])("self-directory row is unchanged for %s", (specifier, expected) => {
    expect(isAllowedImport(specifier, nodeName)).toBe(expected)
  })

  // A sibling's own public contract (its made export, its declared errors) is reachable — never a
  // sibling's private files, and never itself (a specifier naming the caller's own node name is
  // already covered by the self-directory row above, not this one).
  test.each([
    ["mag/graph-nodes/other/graph-node", true],
    ["mag/graph-nodes/other/errors", true],
    ["mag/graph-nodes/other/helper", false],
    ["mag/graph-nodes/other/examples", false],
    [`mag/graph-nodes/${nodeName}/graph-node`, true],
  ])("sibling public-surface row for %s", (specifier, expected) => {
    expect(isAllowedImport(specifier, nodeName)).toBe(expected)
  })
})

describe("nodeInternalTarget", () => {
  test("a self-directory specifier maps to the sibling filename, .ts appended", () => {
    expect(nodeInternalTarget("mag/graph-nodes/alpha/gather", "alpha")).toEqual(Option.some("gather.ts"))
  })

  test("a specifier that already ends .ts is not doubled", () => {
    expect(nodeInternalTarget("mag/graph-nodes/alpha/gather.ts", "alpha")).toEqual(Option.some("gather.ts"))
  })

  test("the bare directory form names no file", () => {
    expect(nodeInternalTarget("mag/graph-nodes/alpha", "alpha")).toEqual(Option.none())
  })

  test("another node's directory is not this node's", () => {
    expect(nodeInternalTarget("mag/graph-nodes/bravo/x", "alpha")).toEqual(Option.none())
  })

  test("a relative specifier is never a self-directory specifier", () => {
    expect(nodeInternalTarget("./x", "alpha")).toEqual(Option.none())
  })

  test("a nested specifier maps to the sibling path", () => {
    expect(nodeInternalTarget("mag/graph-nodes/alpha/sub/helper", "alpha")).toEqual(Option.some("sub/helper.ts"))
  })
})

describe("carriesUnimplementedMarker", () => {
  test.each([
    ["double-quoted", "run: () => { throw new Error(\"GRAPH_NODE_UNIMPLEMENTED: x is unimplemented\") }"],
    ["single-quoted", "run: () => { throw new Error('GRAPH_NODE_UNIMPLEMENTED: x is unimplemented') }"],
    ["backtick-quoted", "run: () => { throw new Error(`GRAPH_NODE_UNIMPLEMENTED: x is unimplemented`) }"],
  ])("accepts the marker %s, opening a string literal", (_label, source) => {
    expect(carriesUnimplementedMarker(source)).toBe(true)
  })

  test("rejects the marker as an imported identifier, never a string literal", () => {
    const source = "import { GRAPH_NODE_UNIMPLEMENTED } from \"mag/runtime/graph-node.shape\"\n" +
      "run: () => { throw new Error(GRAPH_NODE_UNIMPLEMENTED) }"
    expect(carriesUnimplementedMarker(source)).toBe(false)
  })

  test("rejects the marker as a local const, never a string literal", () => {
    const source = "const GRAPH_NODE_UNIMPLEMENTED = 1\nrun: () => { throw new Error(String(GRAPH_NODE_UNIMPLEMENTED)) }"
    expect(carriesUnimplementedMarker(source)).toBe(false)
  })

  test("rejects source with no occurrence of the marker at all", () => {
    expect(carriesUnimplementedMarker("run: () => {}")).toBe(false)
  })

  test("rejects the marker quoted inside a comment, never a string the code opens", () => {
    const source = 'run: () => { throw new Error("not done yet") }\n' +
      '// still not done: "GRAPH_NODE_UNIMPLEMENTED" (see ticket)'
    expect(carriesUnimplementedMarker(source)).toBe(false)
  })

  test("a // inside an earlier string does not hide a real marker on a later line", () => {
    const source = 'description: "see https://example.com/docs",\n' +
      'run: () => { throw new Error("GRAPH_NODE_UNIMPLEMENTED: x is unimplemented") }'
    expect(carriesUnimplementedMarker(source)).toBe(true)
  })
})
