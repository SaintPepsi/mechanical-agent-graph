import { describe, expect, test } from "bun:test"
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Result, Schema } from "effect"
import { SvelteManifestMalformed, SvelteManifestUnreadable } from "mag/graph-nodes/detect-svelte/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/detect-svelte/examples"
import { detectSvelte } from "mag/graph-nodes/detect-svelte/graph-node"
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

const tempRepo = (): string => mkdtempSync(join(tmpdir(), "detect-svelte-test-"))

/** `runPromise`, not `runSync`: `detectSvelte` always provides `platform` internally (`graph-node.ts`), and a real `FileSystem` read genuinely suspends the fiber (`design/graph-node.test.ts`'s own precedent). `text` defaults to empty: the root-manifest tests below rely on the rule that the root is a candidate regardless of what `text` says. */
const runAt = (repo: string, text = "") =>
  Effect.runPromise(
    Effect.result(detectSvelte.run({ text }).pipe(Effect.provideService(RunInfo, testRunInfo({ workRoot: repo }))))
  )

describe("detect-svelte", () => {
  test("the fixtures decode against detect-svelte's own schemas", () => {
    if (!isSchemaHandle(detectSvelte.input)) throw new Error("detectSvelte.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(detectSvelte.input)(example)
    if (!isSchemaHandle(detectSvelte.success)) throw new Error("detectSvelte.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(detectSvelte.success)(example)
  })

  // "No model session" is a type-level property, not a runtime one: `runAt` below provides only
  // `platform` and `RunInfo`, no `ClaudeAgent`, and every test still runs to completion — a
  // `ClaudeAgent` requirement in `detectSvelte.run`'s R channel would be a compile error at that
  // `provide`, before any test body ran.

  test("svelte in dependencies matches, with the declaring manifest's path as evidence", async () => {
    const repo = tempRepo()
    try {
      writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "root", dependencies: { svelte: "^5" } }))
      const result = await runAt(repo)
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({ stack: "svelte", matched: true, manifests: ["package.json"] })
    } finally {
      removeDir(repo)
    }
  })

  test("no manifest declares svelte is a clean non-match, not a failure", async () => {
    const repo = tempRepo()
    try {
      writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "root", dependencies: { effect: "beta" } }))
      const result = await runAt(repo)
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({ stack: "svelte", matched: false, manifests: [] })
    } finally {
      removeDir(repo)
    }
  })

  // The root manifest always qualifies; any other manifest qualifies only when the ticket text
  // names its directory or its own package name (`manifest.ts`'s `candidates`). These three prove
  // that scoping, not the root-only case above.

  test("the root manifest declaring svelte matches regardless of what `text` says", async () => {
    const repo = tempRepo()
    try {
      writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "root", dependencies: { svelte: "^5" } }))
      const result = await runAt(repo, "a ticket about something in plugins/mag/src/runtime, not svelte at all")
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({ stack: "svelte", matched: true, manifests: ["package.json"] })
    } finally {
      removeDir(repo)
    }
  })

  test("a ticket naming a nested project's path matches only that project's manifest", async () => {
    const repo = tempRepo()
    try {
      writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "root" }))
      mkdirSync(join(repo, "plugins", "mag", "projects", "graph-viewer"), { recursive: true })
      writeFileSync(
        join(repo, "plugins", "mag", "projects", "graph-viewer", "package.json"),
        JSON.stringify({ name: "graph-viewer", dependencies: { svelte: "^5" } })
      )
      const result = await runAt(repo, "Add a settings panel under plugins/mag/projects/graph-viewer")
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({
        stack: "svelte",
        matched: true,
        manifests: ["plugins/mag/projects/graph-viewer/package.json"]
      })
    } finally {
      removeDir(repo)
    }
  })

  test("a nested project's manifest alone selects nothing for an unrelated ticket", async () => {
    const repo = tempRepo()
    try {
      writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "root" }))
      mkdirSync(join(repo, "plugins", "mag", "projects", "graph-viewer"), { recursive: true })
      writeFileSync(
        join(repo, "plugins", "mag", "projects", "graph-viewer", "package.json"),
        JSON.stringify({ name: "graph-viewer", dependencies: { svelte: "^5" } })
      )
      const result = await runAt(repo, "Fix a bug in plugins/mag/src/runtime/manifest.ts")
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({ stack: "svelte", matched: false, manifests: [] })
    } finally {
      removeDir(repo)
    }
  })

  test("disconfirming: an unreadable package.json fails SvelteManifestUnreadable, not a false non-match", async () => {
    const repo = tempRepo()
    try {
      mkdirSync(join(repo, "package.json"))
      const result = await runAt(repo)
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(SvelteManifestUnreadable)
    } finally {
      removeDir(repo)
    }
  })

  test("disconfirming: a malformed package.json fails SvelteManifestMalformed, not a false non-match", async () => {
    const repo = tempRepo()
    try {
      writeFileSync(join(repo, "package.json"), "not json")
      const result = await runAt(repo)
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(SvelteManifestMalformed)
    } finally {
      removeDir(repo)
    }
  })
})
