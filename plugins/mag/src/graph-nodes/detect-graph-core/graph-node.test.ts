import { describe, expect, test } from "bun:test"
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Result, Schema } from "effect"
import { GraphCoreManifestMalformed, GraphCoreManifestUnreadable } from "mag/graph-nodes/detect-graph-core/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/detect-graph-core/examples"
import { detectGraphCore } from "mag/graph-nodes/detect-graph-core/graph-node"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo } from "mag/runtime/run-info"
import { testRunInfo } from "mag/test/node-fixture"

/** Fixture-only cleanup, scoped to the temp trees this file creates below (`manifest.test.ts`'s own
 *  precedent): walks by hand rather than a recursive-remove flag, refusing anything outside the OS
 *  temp dir. */
const removeDir = (path: string): void => {
  if (path.trim() === "" || !path.startsWith(tmpdir())) {
    throw new Error(`removeDir: refusing to remove a non-temp path: ${path}`)
  }
  const stat = lstatSync(path)
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const entry of readdirSync(path)) removeDir(join(path, entry))
    rmdirSync(path)
  } else {
    unlinkSync(path)
  }
}

const tempRepo = (): string => mkdtempSync(join(tmpdir(), "detect-graph-core-test-"))

/** A ticket whose `GraphNodes:` line names one node, the shape `PRINCIPLES.md` asks of a GraphNode ticket. */
const NAMES_A_NODE = "GraphNodes: [%] `detect-graph-core`\n\nMatch only on a ticket that names a node."

/** `runPromise`, not `runSync`: `detectGraphCore` always provides `platform` internally (`graph-node.ts`), and a real `FileSystem` read genuinely suspends the fiber (`design/graph-node.test.ts`'s own precedent). `text` defaults to a ticket naming a node, so the manifest tests below exercise the identity half alone. */
const runAt = (repo: string, text = NAMES_A_NODE) =>
  Effect.runPromise(
    Effect.result(detectGraphCore.run({ text }).pipe(Effect.provideService(RunInfo, testRunInfo({ workRoot: repo }))))
  )

describe("detect-graph-core", () => {
  test("the fixtures decode against detect-graph-core's own schemas", () => {
    if (!isSchemaHandle(detectGraphCore.input)) throw new Error("detectGraphCore.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(detectGraphCore.input)(example)
    if (!isSchemaHandle(detectGraphCore.success)) throw new Error("detectGraphCore.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(detectGraphCore.success)(example)
  })

  // "No model session" is a type-level property, not a runtime one: `runAt` below provides only
  // `platform` and `RunInfo`, no `ClaudeAgent`, and every test still runs to completion — a
  // `ClaudeAgent` requirement in `detectGraphCore.run`'s R channel would be a compile error at
  // that `provide`, before any test body ran.

  test("the root manifest named mechanical-agent-graph matches, evidence is the root path alone", async () => {
    const repo = tempRepo()
    try {
      writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "mechanical-agent-graph" }))
      const result = await runAt(repo)
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({ stack: "graph-core", matched: true, manifests: ["package.json"] })
    } finally {
      removeDir(repo)
    }
  })

  test("this repository with a ticket naming no GraphNode is a clean non-match: an empty GraphNodes line, or none at all", async () => {
    const repo = tempRepo()
    try {
      writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "mechanical-agent-graph" }))
      for (const text of ["GraphNodes: none\n\nFix the README.", "Fix the README, which mentions `detect-graph-core` in prose."]) {
        const result = await runAt(repo, text)
        expect(Result.isSuccess(result)).toBe(true)
        if (!Result.isSuccess(result)) return
        expect(result.success).toStrictEqual({ stack: "graph-core", matched: false, manifests: [] })
      }
    } finally {
      removeDir(repo)
    }
  })

  test("a ticket naming no GraphNode never reads the manifest: an unreadable package.json is still a clean non-match", async () => {
    const repo = tempRepo()
    try {
      mkdirSync(join(repo, "package.json"))
      const result = await runAt(repo, "Fix the README.")
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.matched).toBe(false)
    } finally {
      removeDir(repo)
    }
  })

  test("a differently-named root manifest is a clean non-match, not a failure", async () => {
    const repo = tempRepo()
    try {
      writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "some-other-repo" }))
      const result = await runAt(repo)
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({ stack: "graph-core", matched: false, manifests: [] })
    } finally {
      removeDir(repo)
    }
  })

  test("a workspace member merely NAMED mechanical-agent-graph does not match — only the root's identity counts", async () => {
    const repo = tempRepo()
    try {
      writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "root", workspaces: ["packages/*"] }))
      mkdirSync(join(repo, "packages", "mechanical-agent-graph"), { recursive: true })
      writeFileSync(
        join(repo, "packages", "mechanical-agent-graph", "package.json"),
        JSON.stringify({ name: "mechanical-agent-graph" })
      )
      const result = await runAt(repo)
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({ stack: "graph-core", matched: false, manifests: [] })
    } finally {
      removeDir(repo)
    }
  })

  test("disconfirming: an unreadable package.json fails GraphCoreManifestUnreadable, not a false non-match", async () => {
    const repo = tempRepo()
    try {
      mkdirSync(join(repo, "package.json"))
      const result = await runAt(repo)
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(GraphCoreManifestUnreadable)
    } finally {
      removeDir(repo)
    }
  })

  test("disconfirming: a malformed package.json fails GraphCoreManifestMalformed, not a false non-match", async () => {
    const repo = tempRepo()
    try {
      writeFileSync(join(repo, "package.json"), "not json")
      const result = await runAt(repo)
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(GraphCoreManifestMalformed)
    } finally {
      removeDir(repo)
    }
  })
})
