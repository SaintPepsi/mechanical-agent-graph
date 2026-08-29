import { describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Effect, Result, Schema } from "effect"
import { inputExamples, successExamples } from "mag/graph-nodes/recycle-scan/examples"
import {
  RecycleScanDesignUnreadable,
  RecycleScanFileUnreadable,
  RecycleScanGitFailed,
  RecycleScanWriteFailed
} from "mag/graph-nodes/recycle-scan/errors"
import { recycleScan } from "mag/graph-nodes/recycle-scan/graph-node"
import { HIT_CAP } from "mag/graph-nodes/recycle-scan/scan"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo, type RunInfoService } from "mag/runtime/run-info"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { scriptedShell, withRecordRepo } from "mag/test/node-fixture"

const LS_FILES = ["git", "ls-files", "-z"]

/** `git ls-files -z` answering the given tracked paths. */
const tracked = (paths: readonly string[]): ShellResult => ({ exitCode: 0, stdout: paths.map((path) => `${path}\0`).join(""), stderr: "" })

const writeAt = (root: string, relative: string, text: string): string => {
  const path = join(root, relative)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

// No `ClaudeAgent` is provided: "no model session" is a type-level property, `detect-svelte`'s own
// reasoning, since a `ClaudeAgent` requirement in the R channel would fail this `provide` at typecheck.
const runWith = (designPath: string, shell: ShellService, run: RunInfoService) =>
  Effect.runPromise(
    Effect.result(recycleScan.run({ designPath }).pipe(Effect.provide(shellLayer(shell)), Effect.provideService(RunInfo, run)))
  )

const withRepo = <T>(fn: (repoRoot: string, runRoot: string, run: RunInfoService) => Promise<T>) => withRecordRepo("recycle-scan", fn)

describe("recycle-scan", () => {
  test("the fixtures decode against its own schemas", () => {
    if (!isSchemaHandle(recycleScan.input)) throw new Error("recycleScan.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(recycleScan.input)(example)
    if (!isSchemaHandle(recycleScan.success)) throw new Error("recycleScan.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(recycleScan.success)(example)
  })

  test("every backticked name is grepped across the tracked files, in every case, by filename and by line, and the table lands in the run root", () =>
    withRepo(async (repoRoot, runRoot, run) => {
      const designPath = writeAt(repoRoot, "docs/graph/GH-288/design.md", "Reuse `journaled` and `recycle-scan`; skip `not a name`.\n")
      writeAt(repoRoot, "src/journal/journaled.ts", "export const journaled = 1\n")
      writeAt(repoRoot, "src/scan.ts", "const recycleScan = 2\nconst recycle_scan = 3\n")
      writeAt(repoRoot, "src/other.ts", "nothing here\n")
      const { calls, cwds, service } = scriptedShell([tracked(["src/journal/journaled.ts", "src/scan.ts", "src/other.ts"])])

      const result = await runWith(designPath, service, run)
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({ recycleScanPath: `${runRoot}/recycle-scan.md` })
      expect(calls).toStrictEqual([LS_FILES])
      expect(cwds).toStrictEqual([repoRoot])

      const scan = readFileSync(`${runRoot}/recycle-scan.md`, "utf8")
      expect(scan).toContain("| `journaled` | src/journal/journaled.ts |")
      expect(scan).toContain("| `journaled` | src/journal/journaled.ts:1 |")
      expect(scan).toContain("| `recycle-scan` | src/scan.ts:1 |")
      expect(scan).toContain("| `recycle-scan` | src/scan.ts:2 |")
      expect(scan).not.toContain("not a name")
      expect(scan).not.toContain("other.ts")
    }))

  test("a name with no hit says so, and hits past the cap collapse into a count", () =>
    withRepo(async (repoRoot, runRoot, run) => {
      const designPath = writeAt(repoRoot, "design.md", "`absent` and `busy`.\n")
      writeAt(repoRoot, "busy.ts", Array.from({ length: HIT_CAP + 2 }, () => "busy").join("\n"))
      const result = await runWith(designPath, scriptedShell([tracked(["busy.ts"])]).service, run)

      expect(Result.isSuccess(result)).toBe(true)
      const scan = readFileSync(`${runRoot}/recycle-scan.md`, "utf8")
      expect(scan).toContain("| `absent` | none |")
      // The filename hit plus HIT_CAP + 2 line hits: HIT_CAP rows shown, three counted.
      expect(scan).toContain("| `busy` | +3 more |")
    }))

  test("a binary file is skipped, and a re-scan overwrites the table in place", () =>
    withRepo(async (repoRoot, runRoot, run) => {
      const designPath = writeAt(repoRoot, "design.md", "`blob`\n")
      writeAt(repoRoot, "blob.bin", "blob\0blob")
      const first = await runWith(designPath, scriptedShell([tracked(["blob.bin"])]).service, run)
      expect(Result.isSuccess(first)).toBe(true)
      expect(readFileSync(`${runRoot}/recycle-scan.md`, "utf8")).toContain("| `blob` | none |")

      writeFileSync(designPath, "`other`\n")
      const second = await runWith(designPath, scriptedShell([tracked(["blob.bin"])]).service, run)
      expect(Result.isSuccess(second)).toBe(true)
      const scan = readFileSync(`${runRoot}/recycle-scan.md`, "utf8")
      expect(scan).toContain("| `other` | none |")
      expect(scan).not.toContain("`blob`")
    }))

  test("an unreadable design fails RecycleScanDesignUnreadable before any git call", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const { calls, service } = scriptedShell([])
      const result = await runWith(join(repoRoot, "absent.md"), service, run)
      expect(Result.isFailure(result) && result.failure instanceof RecycleScanDesignUnreadable).toBe(true)
      expect(calls).toHaveLength(0)
    }))

  test("a failed ls-files fails RecycleScanGitFailed", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const designPath = writeAt(repoRoot, "design.md", "`x`\n")
      const result = await runWith(designPath, scriptedShell([{ exitCode: 128, stdout: "", stderr: "fatal: not a git repository\n" }]).service, run)
      expect(Result.isFailure(result) && result.failure instanceof RecycleScanGitFailed).toBe(true)
    }))

  test("a tracked file the tree cannot read fails RecycleScanFileUnreadable, naming it", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const designPath = writeAt(repoRoot, "design.md", "`x`\n")
      const result = await runWith(designPath, scriptedShell([tracked(["gone.ts"])]).service, run)
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(RecycleScanFileUnreadable)
      expect((result.failure as RecycleScanFileUnreadable).path).toBe("gone.ts")
    }))

  test("an empty run root fails RecycleScanWriteFailed with 'run root missing', before any read", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const { calls, service } = scriptedShell([])
      const result = await runWith(join(repoRoot, "design.md"), service, { ...run, runRoot: "" })
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(RecycleScanWriteFailed)
      expect((result.failure as RecycleScanWriteFailed).detail).toBe("run root missing")
      expect(calls).toHaveLength(0)
    }))
})
