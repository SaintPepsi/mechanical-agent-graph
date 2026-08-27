// Sink composition, the no-sink baseline, and broken-sink isolation.
//
// This file covers what `tracing.test.ts` explicitly defers: the interrupted-run
// exit-code parity check and the redacted-value-read-back-off-the-file-sink case. It also adds the
// machine-readable proofs `tracing.test.ts`'s console-only harness
// cannot make — run identity, both sinks receiving every event (a different
// composition sends events elsewhere), broken sinks not breaking a run or leaking an unhandled
// rejection, and a full parity comparison against the no-sink baseline.
//
// Every stderr assertion routes through `stripTraceLines`/`traceLines` from `./stderr` —
// never a local reimplementation. Every file-sink path resolves under `tmpdir()` via
// `mkdtempSync`, cleaned up in a `finally`, never under `plugins/mag/` (`cli.test.ts`'s
// whole-tree snapshot check would otherwise red on a stray trace file).
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { readEvents, runHarness } from "./run-harness"
import { traceLines, stripTraceLines } from "./stderr"
import { REQUIRED_ECHO_FLAGS } from "./echo-flags"

const tracingHarnessPath = join(import.meta.dir, "harness-cli-tracing.ts")
const nestedHarnessPath = join(import.meta.dir, "harness-cli-nested.ts")

const runDefault = runHarness(join(import.meta.dir, "harness-cli.ts"))
const runNoSink = runHarness(join(import.meta.dir, "harness-cli-no-sink.ts"))
const runBroken = runHarness(join(import.meta.dir, "harness-cli-broken-sink.ts"))

/** A fresh `tmpdir()` subdirectory holding one `trace.ndjson` path, cleaned up by the caller's `finally`. */
const newTraceFile = (prefix: string): { readonly path: string; readonly cleanup: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`))
  return { path: join(dir, "trace.ndjson"), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Spawns `harnessPath` with `GRAPH_TRACE_FILE` set to `path`. */
const runWithTraceFile = (harnessPath: string) =>
  (path: string, ...argv: readonly string[]) => runHarness(harnessPath, { GRAPH_TRACE_FILE: path })(...argv)

const runTracing = runWithTraceFile(tracingHarnessPath)
const runNested = runWithTraceFile(nestedHarnessPath)

describe("tracing-sinks — two independently-composed sinks each receive every event", () => {
  test("harness-cli-tracing.ts: console's two mag: lines and the file's two events agree", async () => {
    const trace = newTraceFile("graph-tracing-sinks-both")
    try {
      const { stdout, stderr, exitCode } = await runTracing(trace.path, "utility", "echo", ...REQUIRED_ECHO_FLAGS)

      expect(exitCode).toBe(0)
      expect(() => JSON.parse(stdout)).not.toThrow()

      const lines = traceLines(stderr)
      expect(lines.length).toBe(2)
      expect(lines[0]).toBe("mag: [echo] entered")
      expect(lines[1]).toMatch(/^mag: \[echo\] ok \d+\.\d+s$/)

      const events = readEvents(trace.path).filter((event) => event.name === "echo")
      // Compare event SETS, not just counts: one open and one close, the same two events the
      // console's two lines are rendering — a file sink that dropped the close event but kept a
      // stray duplicate open event would still pass a length-2 check without this shape check.
      const opens = events.filter((event) => event.kind === "open")
      const closes = events.filter((event) => event.kind === "close")
      expect(opens.length).toBe(1)
      expect(closes.length).toBe(1)
      const close = closes[0]
      if (close === undefined || close.kind !== "close") {
        throw new Error("expected a close event for echo")
      }
      expect(close.outcome).toBe("ok")
      expect(close.spanId).toBe(opens[0]?.spanId)
    } finally {
      trace.cleanup()
    }
  })

  test("a file-sink-only composition (harness-cli-nested.ts) writes to the file and produces no mag: stderr line", async () => {
    const trace = newTraceFile("graph-tracing-sinks-file-only")
    try {
      const { stderr, exitCode } = await runNested(trace.path, "nested-outer", "--label", "sink-swap")

      expect(exitCode).toBe(0)
      // A different sink composition sends events elsewhere — no console
      // sink here, so zero mag: lines, ever.
      expect(traceLines(stderr).length).toBe(0)

      const events = readEvents(trace.path)
      expect(events.length).toBeGreaterThan(0)
      expect(events.some((event) => event.kind === "open")).toBe(true)
      expect(events.some((event) => event.kind === "close")).toBe(true)
    } finally {
      trace.cleanup()
    }
  })
})

describe("tracing-sinks — the success side: a redacted field read back off the file sink", () => {
  test("secret's close event redacts token, keeps user intact, and leaks nowhere", async () => {
    const trace = newTraceFile("graph-tracing-sinks-secret")
    const secretValue = "super-secret-token-value" // must match fixtures/secret.ts's literal
    try {
      const { stdout, stderr, exitCode } = await runTracing(trace.path, "secret", "--user", "alice")

      expect(exitCode).toBe(0)
      expect(stdout).not.toContain(secretValue)
      for (const line of traceLines(stderr)) {
        expect(line).not.toContain(secretValue)
      }

      const rawFile = readFileSync(trace.path, "utf8")
      expect(rawFile).not.toContain(secretValue)

      const events = readEvents(trace.path).filter((event) => event.name === "secret")
      const close = events.find((event) => event.kind === "close")
      if (close === undefined || close.kind !== "close") {
        throw new Error("expected a close event for secret")
      }

      const SecretValueSchema = Schema.Struct({ token: Schema.String, user: Schema.String })
      const value = Schema.decodeUnknownSync(SecretValueSchema)(close.value)
      expect(value.token).toBe("<redacted>")
      expect(value.user).toBe("alice")

      // Byte-identical stdout against the no-sink baseline — tracing changes nothing observable
      // about the node's own success output.
      const noSinkResult = await runNoSink("secret", "--user", "alice")
      expect(stdout).toBe(noSinkResult.stdout)
    } finally {
      trace.cleanup()
    }
  })
})

describe("tracing-sinks — the interrupt close event, machine-readable", () => {
  test("halt --hold-ms 300: exactly one open and one close for halt, outcome interrupt, no tag field", async () => {
    const trace = newTraceFile("graph-tracing-sinks-interrupt")
    try {
      const tracingResult = await runTracing(trace.path, "halt", "--hold-ms", "300")
      const noSinkResult = await runNoSink("halt", "--hold-ms", "300")

      // Parity, not prediction: this makes no assertion on a specific exit code for
      // exactly this reason (NodeRuntime.runMain's own teardown decides it, not renderFailure).
      expect(tracingResult.exitCode).toBe(noSinkResult.exitCode)
      expect(tracingResult.stdout).toBe(noSinkResult.stdout)
      expect(stripTraceLines(tracingResult.stderr)).toBe(stripTraceLines(noSinkResult.stderr))

      const events = readEvents(trace.path).filter((event) => event.name === "halt")
      const opens = events.filter((event) => event.kind === "open")
      const closes = events.filter((event) => event.kind === "close")
      expect(opens.length).toBe(1)
      expect(closes.length).toBe(1)

      const close = closes[0]
      if (close === undefined || close.kind !== "close") {
        throw new Error("expected a close event for halt")
      }
      expect(close.outcome).toBe("interrupt")
      expect("tag" in close).toBe(false)
    } finally {
      trace.cleanup()
    }
  })
})

describe("tracing-sinks — one run identifier per invocation", () => {
  test("two invocations write two different runIds; within one invocation every event shares one runId", async () => {
    const traceA = newTraceFile("graph-tracing-sinks-runid-a")
    const traceB = newTraceFile("graph-tracing-sinks-runid-b")
    try {
      const [resultA, resultB] = await Promise.all([
        runTracing(traceA.path, "utility", "echo", ...REQUIRED_ECHO_FLAGS),
        runTracing(traceB.path, "utility", "echo", ...REQUIRED_ECHO_FLAGS)
      ])
      expect(resultA.exitCode).toBe(0)
      expect(resultB.exitCode).toBe(0)

      const runIdsA = new Set(readEvents(traceA.path).map((event) => event.runId))
      const runIdsB = new Set(readEvents(traceB.path).map((event) => event.runId))

      expect(runIdsA.size).toBe(1)
      expect(runIdsB.size).toBe(1)

      const [runIdA] = [...runIdsA]
      const [runIdB] = [...runIdsB]
      expect(runIdA).not.toBe(runIdB)
    } finally {
      traceA.cleanup()
      traceB.cleanup()
    }
  })
})

describe("tracing-sinks — broken sinks don't break a run or leak an unhandled rejection", () => {
  const cases: ReadonlyArray<{ readonly label: string; readonly argv: readonly string[] }> = [
    { label: "success", argv: ["utility", "echo", ...REQUIRED_ECHO_FLAGS] },
    { label: "tagged failure", argv: ["utility", "boom", "--trigger", "true"] },
    { label: "defect", argv: ["throws", "--trigger", "true"] }
  ]

  for (const { label, argv } of cases) {
    test(`${label}: stdout, stripped stderr, and exit code match the no-sink baseline`, async () => {
      const brokenResult = await runBroken(...argv)
      const noSinkResult = await runNoSink(...argv)

      expect(brokenResult.exitCode).toBe(noSinkResult.exitCode)
      expect(brokenResult.stdout).toBe(noSinkResult.stdout)
      expect(stripTraceLines(brokenResult.stderr)).toBe(stripTraceLines(noSinkResult.stderr))

      // Neither harness composes a console sink, so both sides carry zero mag: lines.
      expect(traceLines(brokenResult.stderr).length).toBe(0)

      // No unhandled rejection: the rejecting sink's failure never surfaces as
      // Bun/Node's own unhandled-rejection noise on the child's stderr.
      expect(brokenResult.stderr.toLowerCase()).not.toContain("unhandledrejection")
      expect(brokenResult.stderr.toLowerCase()).not.toContain("unhandled promise rejection")
    })
  }
})

describe("tracing-sinks — the default harness differs from the no-sink baseline only by mag: lines", () => {
  const cases: ReadonlyArray<{ readonly label: string; readonly argv: readonly string[] }> = [
    { label: "success", argv: ["utility", "echo", ...REQUIRED_ECHO_FLAGS] },
    { label: "tagged failure", argv: ["utility", "boom", "--trigger", "true"] },
    { label: "defect", argv: ["throws", "--trigger", "true"] }
  ]

  for (const { label, argv } of cases) {
    test(`${label}: stdout, stripped stderr, and exit code match; only mag: lines differ`, async () => {
      const defaultResult = await runDefault(...argv)
      const noSinkResult = await runNoSink(...argv)

      expect(defaultResult.exitCode).toBe(noSinkResult.exitCode)
      expect(defaultResult.stdout).toBe(noSinkResult.stdout)
      expect(stripTraceLines(defaultResult.stderr)).toBe(stripTraceLines(noSinkResult.stderr))

      expect(traceLines(defaultResult.stderr).length).toBe(2)
      expect(traceLines(noSinkResult.stderr).length).toBe(0)
    })
  }
})
