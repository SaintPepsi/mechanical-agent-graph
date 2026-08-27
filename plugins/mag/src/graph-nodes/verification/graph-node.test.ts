import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Result, Schema } from "effect"
import {
  VerificationFailed,
  VerificationReportWriteFailed,
  VerificationRunRootMissing
} from "mag/graph-nodes/verification/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/verification/examples"
import { verification } from "mag/graph-nodes/verification/graph-node"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo } from "mag/runtime/run-info"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { testRunInfo } from "mag/test/node-fixture"

const recordingShell = (reply: ShellResult) => {
  const calls: Array<{ argv: string[]; cwd: string | undefined }> = []
  const service: ShellService = {
    run: (argv, options) => {
      calls.push({ argv: [...argv], cwd: options?.cwd })
      return Effect.succeed(reply)
    }
  }
  return { calls, service }
}

const RUN = testRunInfo()

const SUITE = "bun run typecheck && bun run test"

/** A run root a report write can actually land in, one fresh directory per test. */
const tempRunInfo = () => testRunInfo({ runRoot: mkdtempSync(join(tmpdir(), "verification-node-")) })

const runWith = <A, E>(effect: Effect.Effect<A, E, never>, service: ShellService, run = RUN) =>
  Effect.runPromise(
    Effect.result(effect.pipe(Effect.provide(shellLayer(service)), Effect.provideService(RunInfo, run)))
  )

describe("verification", () => {
  test("the fixtures decode against verification's own schemas", () => {
    if (!isSchemaHandle(verification.input)) throw new Error("verification.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(verification.input)(example)
    if (!isSchemaHandle(verification.success)) throw new Error("verification.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(verification.success)(example)
  })

  // The bug this schema exists to prevent: a `{ command }`-only input makes every call to the
  // same suite journal-identical no matter which tree it ran against.
  test("headSha is required — a caller with no tree identity to offer fails to decode, not silently drops the field", () => {
    const input = verification.input
    if (!isSchemaHandle(input)) throw new Error("verification.input is not a Schema")
    expect(() => Schema.decodeUnknownSync(input)({ command: SUITE })).toThrow()
  })

  test("runs the declared command through sh -c, in RunInfo.workRoot", async () => {
    const { calls, service } = recordingShell({ exitCode: 0, stdout: "42 pass\n", stderr: "" })
    const result = await runWith(verification.run({ command: SUITE, headSha: "aaa111" }), service)

    expect(Result.isSuccess(result)).toBe(true)
    expect(calls).toStrictEqual([{ argv: ["sh", "-c", SUITE], cwd: "/repo" }])
  })

  test("a non-zero exit is VerificationFailed, carrying the code and the output tail", async () => {
    const { service } = recordingShell({ exitCode: 1, stdout: "3 fail\n", stderr: "error: test failed\n" })
    const result = await runWith(verification.run({ command: SUITE, headSha: "aaa111" }), service, tempRunInfo())

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(VerificationFailed)
    const failure = result.failure as VerificationFailed
    expect(failure.exitCode).toBe(1)
    expect(failure.outputTail).toBe("3 fail\n\nerror: test failed")
  })

  test("the tail is capped, a huge log keeps only its end, where the summary lives", async () => {
    const { service } = recordingShell({ exitCode: 1, stdout: `${"x".repeat(10_000)}THE END`, stderr: "" })
    const result = await runWith(verification.run({ command: SUITE, headSha: "aaa111" }), service, tempRunInfo())

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    const tail = (result.failure as VerificationFailed).outputTail
    expect(tail.length).toBeLessThanOrEqual(4000)
    expect(tail.endsWith("THE END")).toBe(true)
  })

  // A red suite records its own evidence to disk before failing, so a repair dispatch can point a
  // resumed session at a file instead of re-typing the tail into a prompt.
  test("a red suite writes verification-1.txt naming the command, exit code and tail, and the failure carries that path", async () => {
    const run = tempRunInfo()
    const { service } = recordingShell({ exitCode: 1, stdout: "3 fail\n", stderr: "error: test failed\n" })
    const result = await runWith(verification.run({ command: SUITE, headSha: "aaa111" }), service, run)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    const failure = result.failure as VerificationFailed
    expect(failure.reportPath).toBe(join(run.runRoot, "verification-1.txt"))
    const report = readFileSync(failure.reportPath, "utf8")
    expect(report).toContain(`Command: ${SUITE}`)
    expect(report).toContain("Exit code: 1")
    expect(report).toContain("3 fail")
    expect(report).toContain("error: test failed")
  })

  test("a second red run in the same root writes verification-2.txt", async () => {
    const run = tempRunInfo()
    const { service } = recordingShell({ exitCode: 1, stdout: "3 fail\n", stderr: "" })
    await runWith(verification.run({ command: SUITE, headSha: "aaa111" }), service, run)
    const second = await runWith(verification.run({ command: SUITE, headSha: "bbb222" }), service, run)

    expect(Result.isFailure(second)).toBe(true)
    if (!Result.isFailure(second)) return
    expect((second.failure as VerificationFailed).reportPath).toBe(join(run.runRoot, "verification-2.txt"))
  })

  // A bare CLI call wires no runInfoLayer, so it carries the default `runRoot: ""`.
  // Unguarded, a red suite reached `writeArtifact("", ...)` and failed
  // VERIFICATION_REPORT_WRITE_FAILED, dropping the command/exitCode/outputTail diagnostic a human
  // reads off VERIFICATION_FAILED (`skills/develop-ticket-graph/SKILL.md`'s own bullet). The guard must fire before the suite even runs.
  test("no runRoot fails VerificationRunRootMissing before the suite runs, red or green", async () => {
    const { calls, service } = recordingShell({ exitCode: 1, stdout: "3 fail\n", stderr: "" })
    const result = await runWith(
      verification.run({ command: SUITE, headSha: "aaa111" }),
      service,
      testRunInfo({ runRoot: "" })
    )

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(VerificationRunRootMissing)
    expect(calls).toStrictEqual([])
  })

  test("a report write failure raises VerificationReportWriteFailed", async () => {
    // `design/graph-node.test.ts`'s ENOTDIR trick: a real file sitting where the run root needs to
    // be a directory.
    const base = mkdtempSync(join(tmpdir(), "verification-node-"))
    const blocker = join(base, "blocker")
    writeFileSync(blocker, "not a directory")
    const run = testRunInfo({ runRoot: join(blocker, "subdir") })
    const { service } = recordingShell({ exitCode: 1, stdout: "3 fail\n", stderr: "" })
    const result = await runWith(verification.run({ command: SUITE, headSha: "aaa111" }), service, run)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(VerificationReportWriteFailed)
    const failure = result.failure as VerificationReportWriteFailed
    expect(failure.runRoot).toBe(run.runRoot)
    expect(failure.detail.length).toBeGreaterThan(0)
  })
})
