import { readdirSync } from "node:fs"
import { describe, expect, test } from "bun:test"
import { nodeFixture } from "mag/test/node-fixture"

describe("nodeFixture", () => {
  test("a node's graph-node.ts imports cleanly through a deliberate type error", async () => {
    const fixture = nodeFixture([
      {
        name: "typo",
        files: {
          "graph-node.ts": [
            "const wrong: number = \"nope\"",
            "export const graphNode = { name: \"typo\" }"
          ].join("\n")
        }
      }
    ])

    try {
      const imported = await import(`${fixture.root}/typo/graph-node.ts`)
      expect(imported.graphNode).toEqual({ name: "typo" })
    } finally {
      fixture.cleanup()
    }
  })

  test("a files spec entry becomes a real fifth entry on disk", () => {
    const fixture = nodeFixture([
      {
        name: "sample",
        files: {
          "graph-node.ts": "",
          "errors.ts": "",
          "graph-node.test.ts": "",
          "examples.ts": "",
          "extra.md": ""
        }
      }
    ])

    try {
      const entries = readdirSync(`${fixture.root}/sample`).sort()
      expect(entries).toEqual(["errors.ts", "examples.ts", "extra.md", "graph-node.test.ts", "graph-node.ts"])
    } finally {
      fixture.cleanup()
    }
  })

  test("cleanup removes the whole temp tree", () => {
    const fixture = nodeFixture([{ name: "sample", files: { "graph-node.ts": "" } }])
    const root = fixture.root

    fixture.cleanup()

    expect(() => readdirSync(root)).toThrow()
  })

  test("phantom-node guard: readdirSync(root) is exactly the node names, never the node_modules symlink", () => {
    const populated = nodeFixture([{ name: "sample", files: { "graph-node.ts": "" } }])
    try {
      expect(readdirSync(populated.root)).toEqual(["sample"])
    } finally {
      populated.cleanup()
    }

    const empty = nodeFixture([])
    try {
      expect(readdirSync(empty.root)).toEqual([])
    } finally {
      empty.cleanup()
    }
  })

  test("a node's graph-node.ts resolves mag/runtime/graph-node.definition, the real self-specifier", async () => {
    const fixture = nodeFixture([
      {
        name: "self-runtime-import",
        files: {
          "graph-node.ts": [
            "import { make } from \"mag/runtime/graph-node.definition\"",
            "import { Effect, Schema } from \"effect\"",
            "export const graphNode = make({",
            "  name: \"self-runtime-import\",",
            "  description: \"d\",",
            "  input: Schema.Struct({}),",
            "  success: Schema.Struct({}),",
            "  run: () => Effect.succeed({})",
            "})"
          ].join("\n")
        }
      }
    ])

    try {
      const imported = await import(`${fixture.root}/self-runtime-import/graph-node.ts`)
      expect(imported.graphNode.name).toEqual("self-runtime-import")
    } finally {
      fixture.cleanup()
    }
  })

  test("a node's graph-node.ts resolves its own sibling through the absolute self-prefix, not the real tree", async () => {
    const fixture = nodeFixture([
      {
        name: "self-sibling-import",
        files: {
          "graph-node.ts": [
            "import { helperValue } from \"mag/graph-nodes/self-sibling-import/helper\"",
            "export const graphNode = { name: helperValue }"
          ].join("\n"),
          "helper.ts": "export const helperValue = \"from-the-fixture-not-the-real-tree\"\n"
        }
      }
    ])

    try {
      const imported = await import(`${fixture.root}/self-sibling-import/graph-node.ts`)
      expect(imported.graphNode).toEqual({ name: "from-the-fixture-not-the-real-tree" })
    } finally {
      fixture.cleanup()
    }
  })

  test("a node's graph-node.ts still resolves a plain effect import (today's behaviour, preserved)", async () => {
    const fixture = nodeFixture([
      {
        name: "effect-import",
        files: {
          "graph-node.ts": [
            "import { Schema } from \"effect\"",
            "export const graphNode = { name: \"effect-import\", schema: Schema.Struct({}) }"
          ].join("\n")
        }
      }
    ])

    try {
      const imported = await import(`${fixture.root}/effect-import/graph-node.ts`)
      expect(imported.graphNode.name).toEqual("effect-import")
    } finally {
      fixture.cleanup()
    }
  })
})
