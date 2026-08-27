import { describe, expect, test } from "bun:test"
import { Effect, Result, Schema } from "effect"
import { buildCli } from "mag/runtime/build-cli"
import type { CommandNode, Registry } from "mag/runtime/types"
import { fixtureNode } from "mag/test/fixtures/command-node"

const goodNode = (name: string): CommandNode => fixtureNode(name, Schema.Struct({ note: Schema.String }))

// A node whose input schema is not a flat struct of supported primitives: `Schema.String` as the
// whole input is rejected at the root (field "<root>"), which is enough to prove the fold reaches
// and propagates deriveFlagSpecs's failure without needing a nested-struct fixture too.
const badNode = (name: string): CommandNode => fixtureNode(name, Schema.String)

describe("buildCli — accepting cases", () => {
  test("an empty registry succeeds: a registry with no entries compiles and runs", async () => {
    const registry: Registry = []

    const exit = await Effect.runPromiseExit(buildCli(registry))

    expect(exit._tag).toBe("Success")
  })

  test("a single top-level command entry succeeds", async () => {
    const registry: Registry = [{ kind: "command", node: goodNode("one") }]

    const exit = await Effect.runPromiseExit(buildCli(registry))

    expect(exit._tag).toBe("Success")
  })

  test("a group containing two command entries succeeds", async () => {
    const registry: Registry = [
      {
        kind: "group",
        group: "widgets",
        description: "widget commands",
        children: [
          { kind: "command", node: goodNode("create") },
          { kind: "command", node: goodNode("delete") }
        ]
      }
    ]

    const exit = await Effect.runPromiseExit(buildCli(registry))

    expect(exit._tag).toBe("Success")
  })
})

describe("buildCli — rejecting cases", () => {
  test("a top-level node with an unsupported input schema fails the whole build, before any argv is parsed", async () => {
    const registry: Registry = [{ kind: "command", node: badNode("bad") }]

    const result = await Effect.runPromise(Effect.result(buildCli(registry)))

    expect(Result.isFailure(result)).toBe(true)
    const error = Result.getOrThrow(Result.flip(result))
    expect(error._tag).toBe("UNSUPPORTED_INPUT_SCHEMA")
    expect(error.node).toBe("bad")
    expect(error.field).toBe("<root>")
    expect(error.type).toBe("String")
  })

  test("a bad node nested one level inside a group fails the same way — rejection is not top-level-only", async () => {
    const registry: Registry = [
      {
        kind: "group",
        group: "widgets",
        description: "widget commands",
        children: [
          { kind: "command", node: goodNode("create") },
          { kind: "command", node: badNode("delete") }
        ]
      }
    ]

    const result = await Effect.runPromise(Effect.result(buildCli(registry)))

    expect(Result.isFailure(result)).toBe(true)
    const error = Result.getOrThrow(Result.flip(result))
    expect(error._tag).toBe("UNSUPPORTED_INPUT_SCHEMA")
    expect(error.node).toBe("delete")
    expect(error.field).toBe("<root>")
    expect(error.type).toBe("String")
  })
})
