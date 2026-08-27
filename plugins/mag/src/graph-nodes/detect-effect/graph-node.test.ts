import { describe, expect, test } from "bun:test"
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Result, Schema } from "effect"
import { EffectManifestMalformed, EffectManifestUnreadable } from "mag/graph-nodes/detect-effect/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/detect-effect/examples"
import { detectEffect } from "mag/graph-nodes/detect-effect/graph-node"
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

const tempRepo = (): string => mkdtempSync(join(tmpdir(), "detect-effect-test-"))

/** `runPromise`, not `runSync`: `detectEffect` always provides `platform` internally (`graph-node.ts`), and a real `FileSystem` read genuinely suspends the fiber (`design/graph-node.test.ts`'s own precedent). `text` defaults to empty: the root-manifest tests below rely on the rule that the root is a candidate regardless of what `text` says. */
const runAt = (repo: string, text = "") =>
  Effect.runPromise(
    Effect.result(detectEffect.run({ text }).pipe(Effect.provideService(RunInfo, testRunInfo({ workRoot: repo }))))
  )

describe("detect-effect", () => {
  test("the fixtures decode against detect-effect's own schemas", () => {
    if (!isSchemaHandle(detectEffect.input)) throw new Error("detectEffect.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(detectEffect.input)(example)
    if (!isSchemaHandle(detectEffect.success)) throw new Error("detectEffect.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(detectEffect.success)(example)
  })

  // "No model session" is a type-level property, not a runtime one: `runAt` below provides only
  // `platform` and `RunInfo`, no `ClaudeAgent`, and every test still runs to completion — a
  // `ClaudeAgent` requirement in `detectEffect.run`'s R channel would be a compile error at that
  // `provide`, before any test body ran.

  test("effect in devDependencies matches, with the declaring manifest's path as evidence", async () => {
    const repo = tempRepo()
    try {
      writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "root", devDependencies: { effect: "beta" } }))
      const result = await runAt(repo)
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({ stack: "effect", matched: true, manifests: ["package.json"] })
    } finally {
      removeDir(repo)
    }
  })

  test("no manifest declares effect is a clean non-match, not a failure", async () => {
    const repo = tempRepo()
    try {
      writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "root", dependencies: { svelte: "^5" } }))
      const result = await runAt(repo)
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({ stack: "effect", matched: false, manifests: [] })
    } finally {
      removeDir(repo)
    }
  })

  // The root manifest always qualifies; any other manifest qualifies only when the ticket text
  // names its directory or its own package name (`manifest.ts`'s `candidates`). These three prove
  // that scoping, not the root-only case above.

  test("the root manifest declaring effect matches regardless of what `text` says", async () => {
    const repo = tempRepo()
    try {
      writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "root", dependencies: { effect: "^4" } }))
      const result = await runAt(repo, "a ticket about the graph-viewer's settings panel, not effect at all")
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({ stack: "effect", matched: true, manifests: ["package.json"] })
    } finally {
      removeDir(repo)
    }
  })

  test("a ticket naming a nested project's path matches only that project's manifest", async () => {
    const repo = tempRepo()
    try {
      writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "root" }))
      mkdirSync(join(repo, "plugins", "mag", "src", "runtime"), { recursive: true })
      writeFileSync(
        join(repo, "plugins", "mag", "src", "runtime", "package.json"),
        JSON.stringify({ name: "runtime", dependencies: { effect: "^4" } })
      )
      const result = await runAt(repo, "Fix a bug in plugins/mag/src/runtime's manifest reader")
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({
        stack: "effect",
        matched: true,
        manifests: ["plugins/mag/src/runtime/package.json"]
      })
    } finally {
      removeDir(repo)
    }
  })

  test("a nested project's manifest alone selects nothing for an unrelated ticket", async () => {
    const repo = tempRepo()
    try {
      writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "root" }))
      mkdirSync(join(repo, "plugins", "mag", "src", "runtime"), { recursive: true })
      writeFileSync(
        join(repo, "plugins", "mag", "src", "runtime", "package.json"),
        JSON.stringify({ name: "runtime", dependencies: { effect: "^4" } })
      )
      const result = await runAt(repo, "Add a settings panel to plugins/mag/projects/graph-viewer")
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({ stack: "effect", matched: false, manifests: [] })
    } finally {
      removeDir(repo)
    }
  })

  test("disconfirming: an unreadable package.json fails EffectManifestUnreadable, not a false non-match", async () => {
    const repo = tempRepo()
    try {
      mkdirSync(join(repo, "package.json"))
      const result = await runAt(repo)
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(EffectManifestUnreadable)
    } finally {
      removeDir(repo)
    }
  })

  test("disconfirming: a malformed package.json fails EffectManifestMalformed, not a false non-match", async () => {
    const repo = tempRepo()
    try {
      writeFileSync(join(repo, "package.json"), "not json")
      const result = await runAt(repo)
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(EffectManifestMalformed)
    } finally {
      removeDir(repo)
    }
  })
})
