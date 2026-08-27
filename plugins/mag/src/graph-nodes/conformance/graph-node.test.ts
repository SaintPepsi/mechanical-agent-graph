import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Option, Result } from "effect"
import { selectNodes } from "mag/graph-nodes/conformance/discovery"
import type { ConformanceViolations, RootUnreadable, UnknownNode, Violation } from "mag/graph-nodes/conformance/errors"
import { conformance } from "mag/graph-nodes/conformance/graph-node"
import { gather } from "mag/graph-nodes/conformance/gather"
import { classifyExtras, ownedFiles } from "mag/graph-nodes/conformance/ownership"
import { runRules } from "mag/graph-nodes/conformance/rules"
import { platform } from "mag/runtime/platform"
import { nodeFixture } from "mag/test/node-fixture"

/**
 * Fails `bun run typecheck` if any `PlatformError` becomes reachable again through
 * `conformance.run`'s error channel. Never executed — constructing an Effect runs nothing.
 */
const _errorChannelIsNamed: Effect.Effect<unknown, RootUnreadable | UnknownNode | ConformanceViolations> =
  conformance.run({})

/**
 * A minimal but importable node: all four required files, the three loadable ones import cleanly,
 * and `graph-node.ts` exports exactly one object carrying every REQUIRED_NODE_FIELDS name — so this
 * fixture also satisfies the required-files, no-extra-entries and node-export rules outright.
 */
const conformingNodeSpec = {
  name: "conforming",
  files: {
    "graph-node.ts":
      "import { Schema } from \"effect\"\n" +
      "import { make } from \"mag/runtime/graph-node.definition\"\n" +
      "export const graphNode = make({ name: \"conforming\", description: \"d\", input: Schema.Struct({}), success: Schema.Struct({}), run: () => { throw new Error(\"GRAPH_NODE_UNIMPLEMENTED\") } })\n",
    "errors.ts":
      "import { Data } from \"effect\"\n" +
      "export class ConformingError extends Data.TaggedError(\"CONFORMING_ERROR\")<{}> {}\n",
    "examples.ts": "export const inputExamples = [{}]\nexport const successExamples = [{}]\n",
    "graph-node.test.ts": "// source-only: never dynamically imported by gather\n"
  }
}

const runGather = (root: string, name: string) => Effect.runPromise(gather(root, name).pipe(Effect.provide(platform)))

const runSelect = (root: string, name: Option.Option<string>) =>
  Effect.runPromise(selectNodes(root, name).pipe(Effect.provide(platform)))

/** Unwraps a `conformance.run` Result: CONFORMANCE_VIOLATIONS' list on failure, empty on success. */
const violationsOf = (result: Result.Result<unknown, { readonly _tag: string; readonly violations?: readonly Violation[] }>) => {
  if (Result.isSuccess(result)) return []
  const error = Result.getOrThrow(Result.flip(result))
  if (error._tag !== "CONFORMANCE_VIOLATIONS") throw new Error(`expected CONFORMANCE_VIOLATIONS, got ${error._tag}`)
  return error.violations ?? []
}

/** Runs conformance.run expecting CONFORMANCE_VIOLATIONS, and hands back the violation list. */
const runFailure = async (root: string) => {
  const result = await Effect.runPromise(Effect.result(conformance.run({ root })))
  expect(Result.isFailure(result)).toBe(true)
  return violationsOf(result)
}

describe("conformance — discovery, selection, reporting", () => {
  test("an empty root passes with nothing checked", async () => {
    const fixture = nodeFixture([])
    try {
      const result = await Effect.runPromise(conformance.run({ root: fixture.root }))
      expect(result).toEqual({ root: fixture.root, checked: [] })
    } finally {
      fixture.cleanup()
    }
  })

  test("three node directories are all checked, sorted", async () => {
    const fixture = nodeFixture([
      { name: "charlie", files: conformingNodeSpec.files },
      { name: "alpha", files: conformingNodeSpec.files },
      { name: "bravo", files: conformingNodeSpec.files }
    ])
    try {
      const result = await Effect.runPromise(conformance.run({ root: fixture.root }))
      expect(result.checked).toEqual(["alpha", "bravo", "charlie"])
    } finally {
      fixture.cleanup()
    }
  })

  test("a loose file directly under the root is ignored, not a violation", async () => {
    const fixture = nodeFixture([{ name: "alpha", files: conformingNodeSpec.files }])
    writeFileSync(join(fixture.root, "README.md"), "not a node")
    try {
      const result = await Effect.runPromise(conformance.run({ root: fixture.root }))
      expect(result.checked).toEqual(["alpha"])
    } finally {
      fixture.cleanup()
    }
  })

  test("a directory nested two levels deep is never treated as a node", async () => {
    const fixture = nodeFixture([
      { name: "outer", files: conformingNodeSpec.files, directories: ["inner"] }
    ])
    try {
      // "inner" is a directory inside "outer", not a sibling of it — discoverNodes never surfaces it as
      // its own checked node (no-extra-entries is what actually flags it, on "outer").
      const violations = await runFailure(fixture.root)
      expect(violations).toEqual([
        {
          node: "outer",
          rule: "no-extra-entries",
          file: join(fixture.root, "outer", "inner"),
          detail: "unexpected entry: inner"
        }
      ])
    } finally {
      fixture.cleanup()
    }
  })

  test("--name selects exactly the named node", async () => {
    const fixture = nodeFixture([
      { name: "alpha", files: conformingNodeSpec.files },
      { name: "bravo", files: conformingNodeSpec.files }
    ])
    try {
      const result = await Effect.runPromise(conformance.run({ root: fixture.root, name: "bravo" }))
      expect(result.checked).toEqual(["bravo"])
    } finally {
      fixture.cleanup()
    }
  })

  test("--name for a missing node fails with CONFORMANCE_UNKNOWN_NODE", async () => {
    const fixture = nodeFixture([{ name: "alpha", files: conformingNodeSpec.files }])
    try {
      const result = await Effect.runPromise(Effect.result(conformance.run({ root: fixture.root, name: "missing" })))
      expect(Result.isFailure(result)).toBe(true)
      const error = Result.getOrThrow(Result.flip(result))
      expect(error._tag).toBe("CONFORMANCE_UNKNOWN_NODE")
    } finally {
      fixture.cleanup()
    }
  })

  test("a relative --root produces the same verdict as the equivalent absolute one", async () => {
    const fixture = nodeFixture([{ name: "alpha", files: conformingNodeSpec.files }])
    try {
      // Resolution is against the process working directory, so a cwd-relative spelling of the
      // fixture root must pass exactly like the absolute spelling — not report every module-backed
      // rule as "did not load" (a relative root left unresolved makes filesystem reads resolve the
      // relative path while gather's dynamic import() takes it for a bare specifier).
      const relativeRoot = relative(process.cwd(), fixture.root)
      const result = await Effect.runPromise(conformance.run({ root: relativeRoot }))
      expect(result).toEqual({ root: fixture.root, checked: ["alpha"] })
    } finally {
      fixture.cleanup()
    }
  })

  test("a root that does not exist fails with CONFORMANCE_ROOT_UNREADABLE", async () => {
    const result = await Effect.runPromise(
      Effect.result(conformance.run({ root: "/nonexistent/gh-86-missing-root" }))
    )
    expect(Result.isFailure(result)).toBe(true)
    const error = Result.getOrThrow(Result.flip(result))
    expect(error._tag).toBe("CONFORMANCE_ROOT_UNREADABLE")
  })

  test("a dangling symlink directly under root is excluded from names and reported as a failure", async () => {
    const fixture = nodeFixture([{ name: "alpha", files: conformingNodeSpec.files }])
    symlinkSync("./nowhere", join(fixture.root, "bogus"))
    try {
      const result = await runSelect(fixture.root, Option.none())
      expect(result.names).toEqual(["alpha"])
      expect(result.failures.some((failure) => failure.entry === "bogus")).toBe(true)
    } finally {
      fixture.cleanup()
    }
  })

  test("--name targeting a dangling symlink succeeds with the failure, not CONFORMANCE_UNKNOWN_NODE", async () => {
    const fixture = nodeFixture([])
    symlinkSync("./nowhere", join(fixture.root, "bogus"))
    try {
      const result = await runSelect(fixture.root, Option.some("bogus"))
      expect(result.names).toEqual([])
      expect(result.failures).toHaveLength(1)
      expect(result.failures[0]?.entry).toBe("bogus")
    } finally {
      fixture.cleanup()
    }
  })

  test("--name for an unrelated node returns no failures from an unrelated dangling symlink", async () => {
    const fixture = nodeFixture([{ name: "alpha", files: conformingNodeSpec.files }])
    symlinkSync("./nowhere", join(fixture.root, "bogus"))
    try {
      const result = await runSelect(fixture.root, Option.some("alpha"))
      expect(result.names).toEqual(["alpha"])
      expect(result.failures).toEqual([])
    } finally {
      fixture.cleanup()
    }
  })
})

describe("gather — one I/O pass per node", () => {
  test("a conforming node yields extraJunk, all four sources, three loaded modules, and no failures", async () => {
    const fixture = nodeFixture([
      { name: "conforming", files: conformingNodeSpec.files, directories: ["nested"] }
    ])
    try {
      const result = await runGather(fixture.root, "conforming")
      expect(result.extraJunk).toContain("nested")
      expect([...result.sources.keys()].sort()).toEqual(
        ["errors.ts", "examples.ts", "graph-node.test.ts", "graph-node.ts"].sort()
      )
      expect(Option.isSome(result.modules.get("graph-node.ts")!)).toBe(true)
      expect(Option.isSome(result.modules.get("errors.ts")!)).toBe(true)
      expect(Option.isSome(result.modules.get("examples.ts")!)).toBe(true)
      expect(result.failures).toEqual([])
    } finally {
      fixture.cleanup()
    }
  })

  test("gather on a path that is a regular file resolves with one failure naming the directory itself", async () => {
    const fixture = nodeFixture([])
    writeFileSync(join(fixture.root, "notadir"), "not a directory\n")
    try {
      const result = await runGather(fixture.root, "notadir")
      expect(result.failures).toHaveLength(1)
      expect(result.failures[0]?.entry).toBe("")
      expect(result.failures[0]?.detail.length).toBeGreaterThan(0)
    } finally {
      fixture.cleanup()
    }
  })

  test("a graph-node.ts that is a directory is a failure, not a crash, and the other sources still gather", async () => {
    const filesWithoutGraphNode = {
      "errors.ts": conformingNodeSpec.files["errors.ts"],
      "examples.ts": conformingNodeSpec.files["examples.ts"],
      "graph-node.test.ts": conformingNodeSpec.files["graph-node.test.ts"]
    }
    const fixture = nodeFixture([
      { name: "dir-graph-node", files: filesWithoutGraphNode, directories: ["graph-node.ts"] }
    ])
    try {
      const result = await runGather(fixture.root, "dir-graph-node")
      expect(result.failures.some((failure) => failure.entry === "graph-node.ts")).toBe(true)
      expect(result.sources.has("graph-node.ts")).toBe(false)
      expect(result.sources.has("errors.ts")).toBe(true)
      expect(result.sources.has("examples.ts")).toBe(true)
      expect(result.sources.has("graph-node.test.ts")).toBe(true)
    } finally {
      fixture.cleanup()
    }
  })

  test("a node missing examples.ts entirely still yields failures: [] — NotFound is unchanged", async () => {
    const filesWithoutExamples = {
      "graph-node.ts": conformingNodeSpec.files["graph-node.ts"],
      "errors.ts": conformingNodeSpec.files["errors.ts"],
      "graph-node.test.ts": conformingNodeSpec.files["graph-node.test.ts"]
    }
    const fixture = nodeFixture([{ name: "missing-examples-gather", files: filesWithoutExamples }])
    try {
      const result = await runGather(fixture.root, "missing-examples-gather")
      expect(result.failures).toEqual([])
      expect(result.sources.has("examples.ts")).toBe(false)
    } finally {
      fixture.cleanup()
    }
  })

  test("a dangling symlink inside a node directory is a failure, and the node's real files are still gathered", async () => {
    const fixture = nodeFixture([{ name: "dangling-inside", files: conformingNodeSpec.files }])
    symlinkSync("./nowhere", join(fixture.root, "dangling-inside", "broken"))
    try {
      const result = await runGather(fixture.root, "dangling-inside")
      expect(result.failures.some((failure) => failure.entry === "broken")).toBe(true)
      expect(result.sources.has("graph-node.ts")).toBe(true)
      expect(result.sources.has("errors.ts")).toBe(true)
      expect(result.sources.has("examples.ts")).toBe(true)
      expect(result.sources.has("graph-node.test.ts")).toBe(true)
    } finally {
      fixture.cleanup()
    }
  })

  test("an errors.ts that throws at import time yields Option.none() without crashing", async () => {
    const fixture = nodeFixture([
      {
        name: "throws",
        files: {
          ...conformingNodeSpec.files,
          "errors.ts": "throw new Error(\"boom, at import time\")\n"
        }
      }
    ])
    try {
      const result = await runGather(fixture.root, "throws")
      expect(Option.isNone(result.modules.get("errors.ts")!)).toBe(true)
      expect(Option.isSome(result.modules.get("graph-node.ts")!)).toBe(true)
    } finally {
      fixture.cleanup()
    }
  })

  test("a graph-node.ts with a deliberate type error still imports at runtime", async () => {
    const fixture = nodeFixture([
      { name: "typeerror", files: { "graph-node.ts": "export const wrong: number = \"nope\"\n" } }
    ])
    try {
      const result = await runGather(fixture.root, "typeerror")
      expect(Option.isSome(result.modules.get("graph-node.ts")!)).toBe(true)
    } finally {
      fixture.cleanup()
    }
  })

  test("graph-node.test.ts is never dynamically imported, though its source is gathered", async () => {
    const fixture = nodeFixture([{ name: "conforming", files: conformingNodeSpec.files }])
    try {
      const result = await runGather(fixture.root, "conforming")
      expect(result.modules.has("graph-node.test.ts")).toBe(false)
      expect(result.sources.has("graph-node.test.ts")).toBe(true)
    } finally {
      fixture.cleanup()
    }
  })
})

describe("classifyExtras — which extras exist at all, pure", () => {
  test("required-only entries produce no extras", () => {
    const { extraSources, extraJunk } = classifyExtras(
      ["errors.ts", "examples.ts", "graph-node.test.ts", "graph-node.ts"],
      []
    )
    expect(extraSources).toEqual([])
    expect(extraJunk).toEqual([])
  })

  test("an extra .ts file is a source", () => {
    const { extraSources } = classifyExtras(["graph-node.ts", "helper.ts"], [])
    expect(extraSources).toEqual(["helper.ts"])
  })

  test("an extra non-.ts file is junk", () => {
    const { extraJunk } = classifyExtras(["graph-node.ts", "extra.md"], [])
    expect(extraJunk).toEqual(["extra.md"])
  })

  test("a directory named looks-like.ts is junk, never a source — kind before name", () => {
    const { extraSources, extraJunk } = classifyExtras(["graph-node.ts", "looks-like.ts"], ["looks-like.ts"])
    expect(extraJunk).toEqual(["looks-like.ts"])
    expect(extraSources).toEqual([])
  })

  test("a .d.ts extra is a source — no extension special-casing", () => {
    const { extraSources } = classifyExtras(["graph-node.ts", "types.d.ts"], [])
    expect(extraSources).toEqual(["types.d.ts"])
  })

  test("extras preserve the entries argument's order", () => {
    const { extraSources, extraJunk } = classifyExtras(["b.ts", "a.md", "a.ts", "b.md"], [])
    expect(extraSources).toEqual(["b.ts", "a.ts"])
    expect(extraJunk).toEqual(["a.md", "b.md"])
  })
})

describe("ownedFiles — the import closure plus the test-sibling grant, pure", () => {
  test("a direct import edge owns its target", () => {
    const sources = new Map([
      ["graph-node.ts", "import { a } from \"mag/graph-nodes/c/a\"\n"],
      ["a.ts", "export const a = 1\n"]
    ])
    expect(ownedFiles(sources, "c")).toEqual(new Set(["graph-node.ts", "a.ts"]))
  })

  test("a transitive chain owns every link", () => {
    const sources = new Map([
      ["graph-node.ts", "import { a } from \"mag/graph-nodes/c/a\"\n"],
      ["a.ts", "import { b } from \"mag/graph-nodes/c/b\"\n"],
      ["b.ts", "export const b = 1\n"]
    ])
    expect(ownedFiles(sources, "c")).toEqual(new Set(["graph-node.ts", "a.ts", "b.ts"]))
  })

  test("a file imported by nothing is not owned", () => {
    const sources = new Map([
      ["graph-node.ts", "export const x = 1\n"],
      ["helper.ts", "export const h = 1\n"]
    ])
    expect(ownedFiles(sources, "c").has("helper.ts")).toBe(false)
  })

  test("an orphan cycle never self-justifies — roots are fixed, not a fixed point", () => {
    const sources = new Map([
      ["graph-node.ts", "export const x = 1\n"],
      ["orphan-a.ts", "import { b } from \"mag/graph-nodes/c/orphan-b\"\n"],
      ["orphan-b.ts", "import { a } from \"mag/graph-nodes/c/orphan-a\"\n"]
    ])
    const owned = ownedFiles(sources, "c")
    expect(owned.has("orphan-a.ts")).toBe(false)
    expect(owned.has("orphan-b.ts")).toBe(false)
  })

  test("a test file is owned through an owned extra sibling", () => {
    const sources = new Map([
      ["graph-node.ts", "import { h } from \"mag/graph-nodes/c/helper\"\n"],
      ["helper.ts", "export const h = 1\n"],
      ["helper.test.ts", "export const t = 1\n"]
    ])
    expect(ownedFiles(sources, "c").has("helper.test.ts")).toBe(true)
  })

  test("a test file is owned through a required sibling — 'owned sibling' includes a required one", () => {
    const sources = new Map([
      ["graph-node.ts", "export const x = 1\n"],
      ["errors.ts", "export class E {}\n"],
      ["errors.test.ts", "export const t = 1\n"]
    ])
    expect(ownedFiles(sources, "c").has("errors.test.ts")).toBe(true)
  })

  test("a test file with no sibling of any kind is not owned", () => {
    const sources = new Map([
      ["graph-node.ts", "export const x = 1\n"],
      ["stray.test.ts", "export const t = 1\n"]
    ])
    expect(ownedFiles(sources, "c").has("stray.test.ts")).toBe(false)
  })

  test("a type-only import is an ownership edge", () => {
    const sources = new Map([
      ["graph-node.ts", "import type { A } from \"mag/graph-nodes/c/a\"\n"],
      ["a.ts", "export type A = number\n"]
    ])
    expect(ownedFiles(sources, "c").has("a.ts")).toBe(true)
  })

  test("another node's specifier and a relative specifier confer nothing", () => {
    const sources = new Map([
      [
        "graph-node.ts",
        "import { x } from \"mag/graph-nodes/other/a\"\n" +
          "import { y } from \"./b\"\n"
      ],
      ["a.ts", "export const x = 1\n"],
      ["b.ts", "export const y = 1\n"]
    ])
    const owned = ownedFiles(sources, "c")
    expect(owned.has("a.ts")).toBe(false)
    expect(owned.has("b.ts")).toBe(false)
  })

  test("a subdirectory specifier names a file gather never puts in sources, so it confers nothing", () => {
    const sources = new Map([["graph-node.ts", "import { z } from \"mag/graph-nodes/c/sub/helper\"\n"]])
    expect(ownedFiles(sources, "c").has("sub/helper.ts")).toBe(false)
  })

  test("a specifier naming a file absent from sources confers nothing, no crash", () => {
    const sources = new Map([["graph-node.ts", "import { a } from \"mag/graph-nodes/c/missing\"\n"]])
    expect(() => ownedFiles(sources, "c")).not.toThrow()
    expect(ownedFiles(sources, "c").has("missing.ts")).toBe(false)
  })
})

describe("rules — required files, no extra entries, node export", () => {
  test("a node missing examples.ts fails required-files, naming the missing path", async () => {
    const filesWithoutExamples = {
      "graph-node.ts": conformingNodeSpec.files["graph-node.ts"],
      "errors.ts": conformingNodeSpec.files["errors.ts"],
      "graph-node.test.ts": conformingNodeSpec.files["graph-node.test.ts"]
    }
    const fixture = nodeFixture([{ name: "missing-examples", files: filesWithoutExamples }])
    try {
      const violations = await runFailure(fixture.root)
      // examples.ts is absent from disk, so both required-files (the file itself) and
      // examples-decode (the module it can never load) independently flag it — each rule reads
      // only the shared I/O snapshot and has no visibility into what another rule already reported.
      expect(violations).toEqual([
        {
          node: "missing-examples",
          rule: "required-files",
          file: join(fixture.root, "missing-examples", "examples.ts"),
          detail: "missing required file: examples.ts"
        },
        {
          node: "missing-examples",
          rule: "examples-decode",
          file: join(fixture.root, "missing-examples", "examples.ts"),
          detail: "examples.ts did not load"
        }
      ])
    } finally {
      fixture.cleanup()
    }
  })

  test("a fifth file fails no-extra-entries, naming the stray file", async () => {
    const fixture = nodeFixture([
      { name: "extra-file", files: { ...conformingNodeSpec.files, "extra.md": "not required\n" } }
    ])
    try {
      const violations = await runFailure(fixture.root)
      expect(violations).toEqual([
        {
          node: "extra-file",
          rule: "no-extra-entries",
          file: join(fixture.root, "extra-file", "extra.md"),
          detail: "unexpected entry: extra.md"
        }
      ])
    } finally {
      fixture.cleanup()
    }
  })

  test("a nested directory fails no-extra-entries, naming the directory", async () => {
    const fixture = nodeFixture([
      { name: "extra-dir", files: conformingNodeSpec.files, directories: ["nested"] }
    ])
    try {
      const violations = await runFailure(fixture.root)
      expect(violations).toEqual([
        {
          node: "extra-dir",
          rule: "no-extra-entries",
          file: join(fixture.root, "extra-dir", "nested"),
          detail: "unexpected entry: nested"
        }
      ])
    } finally {
      fixture.cleanup()
    }
  })

  test("an orphan extra .ts file fails extra-file-ownership, naming the path", async () => {
    const fixture = nodeFixture([
      { name: "orphan-file", files: { ...conformingNodeSpec.files, "orphan.ts": "export const o = 1\n" } }
    ])
    try {
      const violations = await runFailure(fixture.root)
      expect(violations).toEqual([
        {
          node: "orphan-file",
          rule: "extra-file-ownership",
          file: join(fixture.root, "orphan-file", "orphan.ts"),
          detail: "unowned extra file: orphan.ts"
        }
      ])
    } finally {
      fixture.cleanup()
    }
  })

  test("graph-node.ts exporting two objects fails node-export on the count", async () => {
    const fixture = nodeFixture([
      {
        name: "two-exports",
        files: {
          ...conformingNodeSpec.files,
          "graph-node.ts":
            "export const graphNode = { name: \"a\", description: \"d\", input: {}, success: {}, run: () => {} }\n" +
            "export const extra = { another: true }\n"
        }
      }
    ])
    try {
      const violations = await runFailure(fixture.root)
      expect(violations).toEqual([
        {
          node: "two-exports",
          rule: "node-export",
          file: join(fixture.root, "two-exports", "graph-node.ts"),
          detail: "expected exactly one object export, found 2"
        }
      ])
    } finally {
      fixture.cleanup()
    }
  })

  test("graph-node.ts exporting zero objects fails node-export on the count", async () => {
    const fixture = nodeFixture([
      {
        name: "zero-exports",
        files: { ...conformingNodeSpec.files, "graph-node.ts": "export const notAnObject = 42\n" }
      }
    ])
    try {
      const violations = await runFailure(fixture.root)
      expect(violations).toEqual([
        {
          node: "zero-exports",
          rule: "node-export",
          file: join(fixture.root, "zero-exports", "graph-node.ts"),
          detail: "expected exactly one object export, found 0"
        }
      ])
    } finally {
      fixture.cleanup()
    }
  })

  test("graph-node.ts exporting an object missing run fails node-export, naming the field — and also unimplemented-progress, since a run-less export never carries the marker", async () => {
    const fixture = nodeFixture([
      {
        name: "missing-run",
        files: {
          ...conformingNodeSpec.files,
          "graph-node.ts":
            "import { Schema } from \"effect\"\n" +
            "export const graphNode = { name: \"a\", description: \"d\", input: Schema.Struct({}), success: Schema.Struct({}) }\n"
        }
      }
    ])
    try {
      const violations = await runFailure(fixture.root)
      expect(violations).toEqual([
        {
          node: "missing-run",
          rule: "node-export",
          file: join(fixture.root, "missing-run", "graph-node.ts"),
          detail: "missing field: run"
        },
        {
          node: "missing-run",
          rule: "unimplemented-progress",
          file: join(fixture.root, "missing-run", "graph-node.ts"),
          detail: "input and success schemas are both empty structs and the unimplemented marker is gone from graph-node.ts"
        }
      ])
    } finally {
      fixture.cleanup()
    }
  })

  test("the type-error node is structurally complete and passes every shape rule", async () => {
    const fixture = nodeFixture([
      {
        name: "typeerror",
        files: {
          ...conformingNodeSpec.files,
          "graph-node.ts":
            "import { Schema } from \"effect\"\n" +
            "export const wrong: number = \"nope\"\n" +
            "import { make } from \"mag/runtime/graph-node.definition\"\n" +
            "export const graphNode = make({ name: \"typeerror\", description: \"d\", input: Schema.Struct({}), success: Schema.Struct({}), run: () => { throw new Error(\"GRAPH_NODE_UNIMPLEMENTED\") } })\n"
        }
      }
    ])
    try {
      const result = await Effect.runPromise(conformance.run({ root: fixture.root }))
      expect(result.checked).toEqual(["typeerror"])
    } finally {
      fixture.cleanup()
    }
  })
})

describe("rules — tagged error export, examples decode", () => {
  test("errors.ts exporting a Data.TaggedError subclass passes tagged-error-export", async () => {
    const fixture = nodeFixture([
      {
        name: "data-tagged",
        files: {
          ...conformingNodeSpec.files,
          "errors.ts":
            "import { Data } from \"effect\"\n" +
            "export class Boom extends Data.TaggedError(\"BOOM\")<{}> {}\n"
        }
      }
    ])
    try {
      const result = await Effect.runPromise(conformance.run({ root: fixture.root }))
      expect(result.checked).toEqual(["data-tagged"])
    } finally {
      fixture.cleanup()
    }
  })

  test("errors.ts exporting a Schema.TaggedError subclass passes tagged-error-export", async () => {
    const fixture = nodeFixture([
      {
        name: "schema-tagged",
        files: {
          ...conformingNodeSpec.files,
          "errors.ts":
            "import { Schema } from \"effect\"\n" +
            "export class SBoom extends Schema.TaggedError<SBoom>()(\"SBOOM\", {}) {}\n"
        }
      }
    ])
    try {
      const result = await Effect.runPromise(conformance.run({ root: fixture.root }))
      expect(result.checked).toEqual(["schema-tagged"])
    } finally {
      fixture.cleanup()
    }
  })

  test("errors.ts exporting only a plain Error subclass fails tagged-error-export", async () => {
    const fixture = nodeFixture([
      {
        name: "plain-error",
        files: { ...conformingNodeSpec.files, "errors.ts": "export class PlainError extends Error {}\n" }
      }
    ])
    try {
      const violations = await runFailure(fixture.root)
      expect(violations).toEqual([
        {
          node: "plain-error",
          rule: "tagged-error-export",
          file: join(fixture.root, "plain-error", "errors.ts"),
          detail: "no exported tagged error class (an own `name` on the prototype chain)"
        }
      ])
    } finally {
      fixture.cleanup()
    }
  })

  test("examples.ts missing successExamples and with an empty inputExamples array fails examples-decode", async () => {
    const fixture = nodeFixture([
      {
        name: "bad-examples",
        files: { ...conformingNodeSpec.files, "examples.ts": "export const inputExamples = []\n" }
      }
    ])
    try {
      const violations = await runFailure(fixture.root)
      expect(violations).toEqual([
        {
          node: "bad-examples",
          rule: "examples-decode",
          file: join(fixture.root, "bad-examples", "examples.ts"),
          detail: "inputExamples is missing, not an array, or empty"
        },
        {
          node: "bad-examples",
          rule: "examples-decode",
          file: join(fixture.root, "bad-examples", "examples.ts"),
          detail: "successExamples is missing, not an array, or empty"
        }
      ])
    } finally {
      fixture.cleanup()
    }
  })

  test("a fixture that fails to decode against the node's input schema fails examples-decode, detail carrying the decode message", async () => {
    const fixture = nodeFixture([
      {
        name: "bad-decode",
        files: {
          ...conformingNodeSpec.files,
          "graph-node.ts":
            "import { Schema } from \"effect\"\n" +
            "import { make } from \"mag/runtime/graph-node.definition\"\n" +
            "export const graphNode = make({ name: \"bad-decode\", description: \"d\", input: Schema.Struct({ label: Schema.String }), success: Schema.Struct({}), run: () => {} })\n",
          "examples.ts": "export const inputExamples = [{}]\nexport const successExamples = [{}]\n"
        }
      }
    ])
    try {
      const violations = await runFailure(fixture.root)
      expect(violations).toHaveLength(1)
      expect(violations[0]?.node).toBe("bad-decode")
      expect(violations[0]?.rule).toBe("examples-decode")
      expect(violations[0]?.file).toBe(join(fixture.root, "bad-decode", "examples.ts"))
      expect(violations[0]?.detail).toContain("Missing key")
    } finally {
      fixture.cleanup()
    }
  })
})

describe("rules — unimplemented progress, import surface", () => {
  test("both schemas Schema.Struct({}) and a run body carrying the marker string literal passes", async () => {
    const fixture = nodeFixture([{ name: "unimplemented-ok", files: conformingNodeSpec.files }])
    try {
      const result = await Effect.runPromise(conformance.run({ root: fixture.root }))
      expect(result.checked).toEqual(["unimplemented-ok"])
    } finally {
      fixture.cleanup()
    }
  })

  test("the same shape with the marker removed from the run body fails unimplemented-progress", async () => {
    const fixture = nodeFixture([
      {
        name: "marker-removed",
        files: {
          ...conformingNodeSpec.files,
          "graph-node.ts":
            "import { Schema } from \"effect\"\n" +
            "import { make } from \"mag/runtime/graph-node.definition\"\n" +
            "export const graphNode = make({ name: \"marker-removed\", description: \"d\", input: Schema.Struct({}), success: Schema.Struct({}), run: () => {} })\n"
        }
      }
    ])
    try {
      const violations = await runFailure(fixture.root)
      expect(violations).toEqual([
        {
          node: "marker-removed",
          rule: "unimplemented-progress",
          file: join(fixture.root, "marker-removed", "graph-node.ts"),
          detail: "input and success schemas are both empty structs and the unimplemented marker is gone from graph-node.ts"
        }
      ])
    } finally {
      fixture.cleanup()
    }
  })

  test("the marker present but a non-empty input schema passes — only both-empty-and-marker-gone fails", async () => {
    const fixture = nodeFixture([
      {
        name: "nonempty-input",
        files: {
          ...conformingNodeSpec.files,
          "graph-node.ts":
            "import { Schema } from \"effect\"\n" +
            "import { make } from \"mag/runtime/graph-node.definition\"\n" +
            "export const graphNode = make({ name: \"nonempty-input\", description: \"d\", input: Schema.Struct({ label: Schema.String }), success: Schema.Struct({}), run: () => { throw new Error(\"GRAPH_NODE_UNIMPLEMENTED\") } })\n",
          "examples.ts": "export const inputExamples = [{ label: \"x\" }]\nexport const successExamples = [{}]\n"
        }
      }
    ])
    try {
      const result = await Effect.runPromise(conformance.run({ root: fixture.root }))
      expect(result.checked).toEqual(["nonempty-input"])
    } finally {
      fixture.cleanup()
    }
  })

  test("the marker inside an Effect.fn-wrapped generator body still passes — String(run) would miss it", async () => {
    const fixture = nodeFixture([
      {
        name: "wrapped",
        files: {
          ...conformingNodeSpec.files,
          "graph-node.ts":
            "import { Effect, Schema } from \"effect\"\n" +
            "import { make } from \"mag/runtime/graph-node.definition\"\n" +
            "export const graphNode = make({ name: \"wrapped\", description: \"d\", input: Schema.Struct({}), success: Schema.Struct({}), run: Effect.fn(\"wrapped\")(function* () { return yield* Effect.fail(\"GRAPH_NODE_UNIMPLEMENTED: wrapped is unimplemented\") }) })\n"
        }
      }
    ])
    try {
      const result = await Effect.runPromise(conformance.run({ root: fixture.root }))
      expect(result.checked).toEqual(["wrapped"])
    } finally {
      fixture.cleanup()
    }
  })

  // The relative import (`"./errors"`) is the evasion under test, not a resolution workaround: it
  // exercises the same "identifier, not a string literal" evasion as the marker-import test above,
  // while also tripping import-surface (a node may only self-reference via the absolute
  // `mag/graph-nodes/<name>` prefix) — expected and asserted alongside, not a contamination of
  // the unimplemented-progress assertion.
  test("a node whose only marker occurrence is an imported identifier still fails unimplemented-progress (evasion)", async () => {
    const fixture = nodeFixture([
      {
        name: "marker-import-evasion",
        files: {
          ...conformingNodeSpec.files,
          "graph-node.ts":
            "import { Schema } from \"effect\"\n" +
            "import { EVASION_MARKER as GRAPH_NODE_UNIMPLEMENTED } from \"./errors\"\n" +
            "import { make } from \"mag/runtime/graph-node.definition\"\n" +
            "export const graphNode = make({ name: \"marker-import-evasion\", description: \"d\", input: Schema.Struct({}), success: Schema.Struct({}), run: () => { throw new Error(GRAPH_NODE_UNIMPLEMENTED) } })\n",
          "errors.ts":
            "import { Data } from \"effect\"\n" +
            "export class ConformingError extends Data.TaggedError(\"CONFORMING_ERROR\")<{}> {}\n" +
            "export const EVASION_MARKER = \"not-a-real-marker\"\n"
        }
      }
    ])
    try {
      const violations = await runFailure(fixture.root)
      expect(violations).toEqual([
        {
          node: "marker-import-evasion",
          rule: "unimplemented-progress",
          file: join(fixture.root, "marker-import-evasion", "graph-node.ts"),
          detail: "input and success schemas are both empty structs and the unimplemented marker is gone from graph-node.ts"
        },
        {
          node: "marker-import-evasion",
          rule: "import-surface",
          file: join(fixture.root, "marker-import-evasion", "graph-node.ts"),
          detail: "disallowed import: ./errors"
        }
      ])
    } finally {
      fixture.cleanup()
    }
  })

  test("a node whose only marker occurrence is a local const still fails unimplemented-progress (evasion)", async () => {
    const fixture = nodeFixture([
      {
        name: "marker-const-evasion",
        files: {
          ...conformingNodeSpec.files,
          "graph-node.ts":
            "import { Schema } from \"effect\"\n" +
            "const GRAPH_NODE_UNIMPLEMENTED = 1\n" +
            "import { make } from \"mag/runtime/graph-node.definition\"\n" +
            "export const graphNode = make({ name: \"marker-const-evasion\", description: \"d\", input: Schema.Struct({}), success: Schema.Struct({}), run: () => { throw new Error(String(GRAPH_NODE_UNIMPLEMENTED)) } })\n"
        }
      }
    ])
    try {
      const violations = await runFailure(fixture.root)
      expect(violations).toEqual([
        {
          node: "marker-const-evasion",
          rule: "unimplemented-progress",
          file: join(fixture.root, "marker-const-evasion", "graph-node.ts"),
          detail: "input and success schemas are both empty structs and the unimplemented marker is gone from graph-node.ts"
        }
      ])
    } finally {
      fixture.cleanup()
    }
  })

  test("a node file importing a sibling node's PRIVATE module fails import-surface, naming the importing file", async () => {
    const fixture = nodeFixture([
      {
        name: "sibling-import",
        files: {
          ...conformingNodeSpec.files,
          "graph-node.test.ts": "import { helper } from \"mag/graph-nodes/other/helper\"\n"
        }
      }
    ])
    try {
      const violations = await runFailure(fixture.root)
      expect(violations).toEqual([
        {
          node: "sibling-import",
          rule: "import-surface",
          file: join(fixture.root, "sibling-import", "graph-node.test.ts"),
          detail: "disallowed import: mag/graph-nodes/other/helper"
        }
      ])
    } finally {
      fixture.cleanup()
    }
  })

  test("a node file importing a sibling node's PUBLIC surface (graph-node, errors) passes import-surface", async () => {
    const fixture = nodeFixture([
      {
        name: "sibling-public-surface",
        files: {
          ...conformingNodeSpec.files,
          "graph-node.test.ts":
            "import { OtherError } from \"mag/graph-nodes/other/errors\"\n" +
            "import { otherNode } from \"mag/graph-nodes/other/graph-node\"\n"
        }
      }
    ])
    try {
      const result = await Effect.runPromise(Effect.result(conformance.run({ root: fixture.root })))
      const violations = violationsOf(result)
      expect(violations.filter((violation) => violation.rule === "import-surface")).toEqual([])
    } finally {
      fixture.cleanup()
    }
  })

  test("a node file with a relative import fails import-surface, the same as a named sibling", async () => {
    const fixture = nodeFixture([
      {
        name: "relative-import",
        files: {
          ...conformingNodeSpec.files,
          "graph-node.test.ts": "import { inputExamples } from \"./examples\"\n"
        }
      }
    ])
    try {
      const violations = await runFailure(fixture.root)
      expect(violations).toEqual([
        {
          node: "relative-import",
          rule: "import-surface",
          file: join(fixture.root, "relative-import", "graph-node.test.ts"),
          detail: "disallowed import: ./examples"
        }
      ])
    } finally {
      fixture.cleanup()
    }
  })

  test("effect, node:*, bun:*, mag/runtime/*, the test-support module, and the node's own directory are all allowed", async () => {
    const fixture = nodeFixture([
      {
        name: "allowed-imports",
        files: {
          ...conformingNodeSpec.files,
          "graph-node.test.ts":
            "import { test } from \"bun:test\"\n" +
            "import { join } from \"node:path\"\n" +
            "import { Effect } from \"effect\"\n" +
            "import { nodeFixture } from \"mag/test/node-fixture\"\n" +
            "import { helper } from \"mag/runtime/x\"\n" +
            "import { sibling } from \"mag/graph-nodes/allowed-imports/helper\"\n"
        }
      }
    ])
    try {
      const result = await Effect.runPromise(Effect.result(conformance.run({ root: fixture.root })))
      // graph-node.test.ts is source-only (never dynamically imported), so the module-resolution
      // failures these specifiers would hit if loaded are irrelevant here — only the allow-list
      // check over the raw text matters, and it must find nothing to reject.
      const violations = violationsOf(result)
      expect(violations.filter((violation) => violation.rule === "import-surface")).toEqual([])
    } finally {
      fixture.cleanup()
    }
  })
})

describe("rules — journaled construction", () => {
  test("a complete node assembled by hand instead of make() fails journaled-construction", async () => {
    const fixture = nodeFixture([
      {
        name: "hand-assembled",
        files: {
          ...conformingNodeSpec.files,
          "graph-node.ts":
            "import { Schema } from \"effect\"\n" +
            "export const graphNode = { name: \"hand-assembled\", description: \"d\", input: Schema.Struct({}), success: Schema.Struct({}), run: () => { throw new Error(\"GRAPH_NODE_UNIMPLEMENTED\") } }\n"
        }
      }
    ])
    try {
      const violations = await runFailure(fixture.root)
      expect(violations).toEqual([
        {
          node: "hand-assembled",
          rule: "journaled-construction",
          file: join(fixture.root, "hand-assembled", "graph-node.ts"),
          detail:
            "not built by make(): the export lacks the journal marker, so its runs would leave no record " +
            "— construct it with make() from mag/runtime/graph-node.definition"
        }
      ])
    } finally {
      fixture.cleanup()
    }
  })

  test("a node derived by spreading a made node without re-making it still fails — the marker is non-enumerable", async () => {
    const fixture = nodeFixture([
      {
        name: "spread-derived",
        files: {
          ...conformingNodeSpec.files,
          "graph-node.ts":
            "import { Schema } from \"effect\"\n" +
            "import { make } from \"mag/runtime/graph-node.definition\"\n" +
            "const base = make({ name: \"base\", description: \"d\", input: Schema.Struct({}), success: Schema.Struct({}), run: () => { throw new Error(\"GRAPH_NODE_UNIMPLEMENTED\") } })\n" +
            "export const graphNode = { ...base, name: \"spread-derived\" }\n"
        }
      }
    ])
    try {
      const violations = await runFailure(fixture.root)
      expect(violations.map((violation) => violation.rule)).toEqual(["journaled-construction"])
    } finally {
      fixture.cleanup()
    }
  })
})

describe("fixture roots — one integration test per rule", () => {
  test("graph-node.test.ts -> a.ts -> b.ts, the test file as root, passes conformance outright", async () => {
    const fixture = nodeFixture([
      {
        name: "owned-chain",
        files: {
          ...conformingNodeSpec.files,
          "graph-node.test.ts":
            "import { a } from \"mag/graph-nodes/owned-chain/a\"\n" +
            "export const marker = a\n",
          "a.ts": "import { b } from \"mag/graph-nodes/owned-chain/b\"\nexport const a = b\n",
          "b.ts": "export const b = 1\n"
        }
      }
    ])
    try {
      const result = await Effect.runPromise(conformance.run({ root: fixture.root }))
      expect(result.checked).toEqual(["owned-chain"])
    } finally {
      fixture.cleanup()
    }
  })

  test("an orphan cycle fails both files — a cycle is not a root", async () => {
    const fixture = nodeFixture([
      {
        name: "orphan-cycle",
        files: {
          ...conformingNodeSpec.files,
          "orphan-a.ts": "import { b } from \"mag/graph-nodes/orphan-cycle/orphan-b\"\nexport const a = b\n",
          "orphan-b.ts": "import { a } from \"mag/graph-nodes/orphan-cycle/orphan-a\"\nexport const b = a\n"
        }
      }
    ])
    try {
      const violations = await runFailure(fixture.root)
      expect(violations).toEqual([
        {
          node: "orphan-cycle",
          rule: "extra-file-ownership",
          file: join(fixture.root, "orphan-cycle", "orphan-a.ts"),
          detail: "unowned extra file: orphan-a.ts"
        },
        {
          node: "orphan-cycle",
          rule: "extra-file-ownership",
          file: join(fixture.root, "orphan-cycle", "orphan-b.ts"),
          detail: "unowned extra file: orphan-b.ts"
        }
      ])
    } finally {
      fixture.cleanup()
    }
  })

  test("an extra file imported by graph-node.test.ts plus its test sibling passes", async () => {
    const fixture = nodeFixture([
      {
        name: "helper-owned",
        files: {
          ...conformingNodeSpec.files,
          "graph-node.test.ts":
            "import { h } from \"mag/graph-nodes/helper-owned/helper\"\n" +
            "export const marker = h\n",
          "helper.ts": "export const h = 1\n",
          "helper.test.ts": "export const t = 1\n"
        }
      }
    ])
    try {
      const result = await Effect.runPromise(conformance.run({ root: fixture.root }))
      expect(result.checked).toEqual(["helper-owned"])
    } finally {
      fixture.cleanup()
    }
  })

  test("a stray test file with no owned subject fails, detail naming the missing sibling", async () => {
    const fixture = nodeFixture([
      {
        name: "stray-test",
        files: { ...conformingNodeSpec.files, "stray.test.ts": "export const t = 1\n" }
      }
    ])
    try {
      const violations = await runFailure(fixture.root)
      expect(violations).toEqual([
        {
          node: "stray-test",
          rule: "extra-file-ownership",
          file: join(fixture.root, "stray-test", "stray.test.ts"),
          detail: "unowned extra test file: stray.test.ts (no owned sibling stray.ts)"
        }
      ])
    } finally {
      fixture.cleanup()
    }
  })

  test("errors.test.ts passes beside the required errors.ts, no import needed", async () => {
    const fixture = nodeFixture([
      {
        name: "errors-test-sibling",
        files: { ...conformingNodeSpec.files, "errors.test.ts": "export const t = 1\n" }
      }
    ])
    try {
      const result = await Effect.runPromise(conformance.run({ root: fixture.root }))
      expect(result.checked).toEqual(["errors-test-sibling"])
    } finally {
      fixture.cleanup()
    }
  })

  test("a directory named looks-like.ts fails no-extra-entries as junk, never read as source", async () => {
    const fixture = nodeFixture([
      { name: "dir-looks-like-ts", files: conformingNodeSpec.files, directories: ["looks-like.ts"] }
    ])
    try {
      const violations = await runFailure(fixture.root)
      expect(violations).toEqual([
        {
          node: "dir-looks-like-ts",
          rule: "no-extra-entries",
          file: join(fixture.root, "dir-looks-like-ts", "looks-like.ts"),
          detail: "unexpected entry: looks-like.ts"
        }
      ])
    } finally {
      fixture.cleanup()
    }
  })

  test("a disallowed import in both a required file and an owned extra produces two ordered import-surface violations", async () => {
    const fixture = nodeFixture([
      {
        name: "import-surface-order",
        files: {
          ...conformingNodeSpec.files,
          "graph-node.test.ts":
            "import { h } from \"mag/graph-nodes/import-surface-order/helper\"\n" +
            "import \"fs\"\n" +
            "export const marker = h\n",
          "helper.ts": "import \"fs\"\nexport const h = 1\n"
        }
      }
    ])
    try {
      const result = await Effect.runPromise(Effect.result(conformance.run({ root: fixture.root })))
      // Filtered, not a whole-array `toEqual`: the fixture's own required file (graph-node.test.ts)
      // is spoiled too, so other rules may legitimately also fire — only the import-surface ordering
      // claim (required file before extra) is this test's subject.
      const violations = violationsOf(result).filter((violation) => violation.rule === "import-surface")
      expect(violations).toEqual([
        {
          node: "import-surface-order",
          rule: "import-surface",
          file: join(fixture.root, "import-surface-order", "graph-node.test.ts"),
          detail: "disallowed import: fs"
        },
        {
          node: "import-surface-order",
          rule: "import-surface",
          file: join(fixture.root, "import-surface-order", "helper.ts"),
          detail: "disallowed import: fs"
        }
      ])
    } finally {
      fixture.cleanup()
    }
  })

  test("a type-broken graph-node.ts still confers ownership through its import, zero extra-file-ownership violations", async () => {
    const fixture = nodeFixture([
      {
        name: "type-error-import",
        files: {
          ...conformingNodeSpec.files,
          "graph-node.ts":
            "import { h } from \"mag/graph-nodes/type-error-import/helper\"\n" +
            "const x: string = 123\n" +
            "export const marker = h\n",
          "helper.ts": "export const h = 1\n"
        }
      }
    ])
    try {
      const result = await Effect.runPromise(Effect.result(conformance.run({ root: fixture.root })))
      // Ownership is text-only: the specifier is read regardless of the type error, so helper.ts is
      // owned. graph-node.ts's self-directory specifier does resolve under the fixture's `mag`
      // shim, but the module still doesn't export a conforming node, so node-export / examples-decode
      // legitimately also fire — this assertion filters to extra-file-ownership only, and stays green
      // regardless of what the other rules report.
      const violations = violationsOf(result).filter((violation) => violation.rule === "extra-file-ownership")
      expect(violations).toEqual([])
    } finally {
      fixture.cleanup()
    }
  })
})

// A source read, not a repo-wide grep — an import-surface fixture in this file legitimately
// contains the literal text "node:path", which a repo grep would trip on.
test("rules.ts builds paths through Path.Path, never node:path", () => {
  const source = readFileSync(join(import.meta.dir, "rules.ts"), "utf8")
  expect(source).not.toContain("node:path")
})

/** Does `chmod 0o000` actually block a read here? Probed, never inferred from a uid. */
const canChmodBlockRead = (): boolean => {
  const probe = mkdtempSync(join(tmpdir(), "graph-chmod-probe-"))
  try {
    chmodSync(probe, 0o000)
    readdirSync(probe)
    return false
  } catch {
    return true
  } finally {
    chmodSync(probe, 0o755)
    rmSync(probe, { recursive: true, force: true })
  }
}

describe("read-failure — every I/O failure the snapshot carries renders as a named violation", () => {
  test("gather on a path that is a regular file yields a read-failure naming the directory itself via runRules", async () => {
    const fixture = nodeFixture([])
    writeFileSync(join(fixture.root, "notadir"), "not a directory\n")
    try {
      const subject = await runGather(fixture.root, "notadir")
      const violations = await Effect.runPromise(runRules(subject).pipe(Effect.provide(platform)))
      const readFailures = violations.filter((violation) => violation.rule === "read-failure")
      expect(readFailures).toEqual([
        expect.objectContaining({
          node: "notadir",
          rule: "read-failure",
          file: join(fixture.root, "notadir")
        })
      ])
      expect(readFailures[0]?.detail.length).toBeGreaterThan(0)
    } finally {
      fixture.cleanup()
    }
  })

  test("a directory-shaped graph-node.ts is a read-failure, and the node's other rules still fire", async () => {
    const filesWithoutGraphNode = {
      "errors.ts": conformingNodeSpec.files["errors.ts"],
      "examples.ts": conformingNodeSpec.files["examples.ts"],
      "graph-node.test.ts": conformingNodeSpec.files["graph-node.test.ts"]
    }
    const fixture = nodeFixture([
      { name: "dir-graph-node", files: filesWithoutGraphNode, directories: ["graph-node.ts"] }
    ])
    try {
      const violations = await runFailure(fixture.root)
      const readFailure = violations.find(
        (violation) => violation.rule === "read-failure" && violation.file === join(fixture.root, "dir-graph-node", "graph-node.ts")
      )
      expect(readFailure).toBeDefined()
      expect(readFailure?.node).toBe("dir-graph-node")
      // A broken graph-node.ts must not blind the run to the node's other rules — required-files
      // also fires, since graph-node.ts is absent from `sources` for that same reason.
      const otherViolations = violations.filter(
        (violation) => violation.node === "dir-graph-node" && violation.rule !== "read-failure"
      )
      expect(otherViolations.length).toBeGreaterThan(0)
    } finally {
      fixture.cleanup()
    }
  })

  test("a dangling symlink directly under root is a root-level read-failure named by the entry", async () => {
    const fixture = nodeFixture([{ name: "alpha", files: conformingNodeSpec.files }])
    symlinkSync("./nowhere", join(fixture.root, "bogus"))
    try {
      const violations = await runFailure(fixture.root)
      const readFailure = violations.find((violation) => violation.rule === "read-failure" && violation.node === "bogus")
      expect(readFailure).toBeDefined()
      expect(readFailure?.file).toBe(join(fixture.root, "bogus"))
    } finally {
      fixture.cleanup()
    }
  })

  test("a dangling symlink inside a conforming node directory is a node-level read-failure", async () => {
    const fixture = nodeFixture([{ name: "dangling-inside", files: conformingNodeSpec.files }])
    symlinkSync("./nowhere", join(fixture.root, "dangling-inside", "broken"))
    try {
      const violations = await runFailure(fixture.root)
      const readFailure = violations.find(
        (violation) => violation.rule === "read-failure" && violation.node === "dangling-inside"
      )
      expect(readFailure).toBeDefined()
      expect(readFailure?.file).toBe(join(fixture.root, "dangling-inside", "broken"))
    } finally {
      fixture.cleanup()
    }
  })

  test("--name targeting a dangling symlink fails CONFORMANCE_VIOLATIONS carrying the read-failure, never CONFORMANCE_UNKNOWN_NODE", async () => {
    const fixture = nodeFixture([])
    symlinkSync("./nowhere", join(fixture.root, "bogus"))
    try {
      const result = await Effect.runPromise(Effect.result(conformance.run({ root: fixture.root, name: "bogus" })))
      expect(Result.isFailure(result)).toBe(true)
      const error = Result.getOrThrow(Result.flip(result))
      expect(error._tag).toBe("CONFORMANCE_VIOLATIONS")
      const violations = violationsOf(result)
      const readFailure = violations.find((violation) => violation.rule === "read-failure" && violation.node === "bogus")
      expect(readFailure).toBeDefined()
    } finally {
      fixture.cleanup()
    }
  })

  test("ordering: a node's read-failure precedes its other violations (row 0 of RULES)", async () => {
    const filesWithoutGraphNode = {
      "errors.ts": conformingNodeSpec.files["errors.ts"],
      "examples.ts": conformingNodeSpec.files["examples.ts"],
      "graph-node.test.ts": conformingNodeSpec.files["graph-node.test.ts"]
    }
    const fixture = nodeFixture([
      { name: "dir-graph-node-order", files: filesWithoutGraphNode, directories: ["graph-node.ts"] }
    ])
    try {
      const violations = await runFailure(fixture.root)
      const nodeViolations = violations.filter((violation) => violation.node === "dir-graph-node-order")
      expect(nodeViolations.length).toBeGreaterThan(1)
      expect(nodeViolations[0]?.rule).toBe("read-failure")
    } finally {
      fixture.cleanup()
    }
  })

  test.skipIf(!canChmodBlockRead())(
    "a chmod 0o000 node directory is a read-failure via conformance.run end-to-end (skipped when chmod 0o000 doesn't block reads — e.g. running as root)",
    async () => {
      const fixture = nodeFixture([{ name: "chmod-blocked", files: conformingNodeSpec.files }])
      const nodeDir = join(fixture.root, "chmod-blocked")
      try {
        chmodSync(nodeDir, 0o000)
        try {
          const violations = await runFailure(fixture.root)
          const readFailure = violations.find(
            (violation) =>
              violation.rule === "read-failure" && violation.node === "chmod-blocked" && violation.file === nodeDir
          )
          expect(readFailure).toBeDefined()
        } finally {
          // Restore before fixture.cleanup() — rmSync on a 0o000 subtree fails for a non-root user,
          // and force:true would swallow that failure and leak the temp tree on CI.
          chmodSync(nodeDir, 0o755)
        }
      } finally {
        fixture.cleanup()
      }
    }
  )
})
