import { describe, expect, test } from "bun:test"
import { nodeFixture } from "./node-fixture"
import { runHarness } from "./run-harness"
import { traceLines, nonEmptyLines, stripTraceLines } from "./stderr"
import { REQUIRED_ECHO_FLAGS } from "./echo-flags"

/**
 * Tracing is on by default, at the existing CLI entry, with
 * no new entry point — `test/harness-cli.ts` is exactly `src/cli.ts`'s shape, unmodified. Real
 * subprocess integration, matching `cli.test.ts`'s no-mocks house rule: `Bun.spawn` a real `bun`
 * child process against the harness and assert on its real stdout/stderr.
 *
 * The cases below extend this same file with more coverage (all four outcomes, redaction, etc.);
 * this first case only proves the entry seam itself is wired and on.
 */

const run = runHarness(`${import.meta.dir}/harness-cli.ts`)

describe("tracing — on by default at the existing CLI entry", () => {
  test("utility echo writes an entered line and an ok line to stderr; stdout stays one JSON line", async () => {
    const { stdout, stderr, exitCode } = await run("utility", "echo", ...REQUIRED_ECHO_FLAGS)

    expect(exitCode).toBe(0)

    // stdout is unaffected — still exactly one JSON line.
    expect(nonEmptyLines(stdout).length).toBe(1)
    expect(() => JSON.parse(stdout)).not.toThrow()

    // Tracing is on with no new entry point — the existing harness alone produces
    // both lifecycle lines on stderr.
    const lines = traceLines(stderr)
    expect(lines.some((line) => line === "mag: [echo] entered")).toBe(true)
    expect(lines.some((line) => /^mag: \[echo\] ok \d+\.\d+s$/.test(line))).toBe(true)
  })
})

/**
 * Core integration, end to end, through the default sinks (console only — the
 * `harness-cli.ts` shape `main` defaults to). Real subprocesses, matching `cli.test.ts`'s
 * no-mocks house rule. Every stderr read goes through `stripTraceLines`/`nonEmptyLines`, and
 * every `mag:`-line read goes through the shared `traceLines` — both from `./stderr`.
 */
describe("tracing — every node run writes one open and one close event, all four outcomes", () => {
  test("success: exactly one entered line then exactly one ok line, in that order, on stderr", async () => {
    const { stdout, stderr, exitCode } = await run("utility", "echo", ...REQUIRED_ECHO_FLAGS)

    expect(exitCode).toBe(0)

    const lines = traceLines(stderr)
    expect(lines.length).toBe(2)
    expect(lines[0]).toBe("mag: [echo] entered")
    expect(lines[1]).toMatch(/^mag: \[echo\] ok \d+\.\d+s$/)

    // Tracing changes nothing about stdout.
    expect(nonEmptyLines(stdout).length).toBe(1)
    expect(() => JSON.parse(stdout)).not.toThrow()
  })

  test("tagged failure: boom writes entered + FAIL BOOM; exit code and stderr body unchanged", async () => {
    const { stdout, stderr, exitCode } = await run("utility", "boom", "--trigger", "true")

    expect(exitCode).toBe(1)
    expect(stdout).toBe("")

    const lines = traceLines(stderr)
    expect(lines.length).toBe(2)
    expect(lines[0]).toBe("mag: [boom] entered")
    expect(lines[1]).toMatch(/^mag: \[boom\] FAIL BOOM \d+\.\d+s$/)

    // cli.test.ts's existing expectation, unchanged, once the mag: lines are stripped.
    const body = nonEmptyLines(stripTraceLines(stderr))
    expect(body.length).toBe(1)
    const match = /^BOOM: (\{.*\})$/.exec(body[0])
    expect(match).not.toBeNull()
    expect(JSON.parse(match![1])).toEqual({ code: 500, reason: "always fails" })
  })

  test("defect: throws writes entered + DIE; exit code still 1", async () => {
    const { stdout, stderr, exitCode } = await run("throws", "--trigger", "true")

    expect(exitCode).toBe(1)
    expect(stdout).toBe("")

    const lines = traceLines(stderr)
    expect(lines.length).toBe(2)
    expect(lines[0]).toBe("mag: [throws] entered")
    expect(lines[1]).toMatch(/^mag: \[throws\] DIE \S+ \d+\.\d+s$/)
  })

  test("interrupt, the fourth outcome, end to end: halt writes entered + INTERRUPT, no tag, stdout empty", async () => {
    const { stdout, stderr, exitCode } = await run("halt", "--hold-ms", "300")

    // Do NOT hand-predict the exit code of an interrupted run — run-cli.ts's
    // `Effect.catch`/`Effect.catchDefect` only see the error channel, and an interruption never
    // reaches either, so `renderFailure` never runs and the number comes from
    // `NodeRuntime.runMain`'s own teardown. So this case deliberately makes no assertion on
    // `exitCode`; the parity check that does — comparing this same invocation against
    // `harness-cli-no-sink.ts` — lives in `tracing-sinks.test.ts`.
    void exitCode

    expect(stdout).toBe("")

    const lines = traceLines(stderr)
    expect(lines.length).toBe(2)
    expect(lines[0]).toBe("mag: [halt] entered")
    // The close line's own template (console-sink.ts's CLOSE_LINE.interrupt row) carries no tag
    // at all — the anchored regex below is exactly that assertion, not just a loose "contains".
    expect(lines[1]).toMatch(/^mag: \[halt\] INTERRUPT \d+\.\d+s$/)
  })

  test("rejected input opens no node run — zero mag: lines, same rejection as before tracing", async () => {
    const { stdout, stderr, exitCode } = await run(
      "utility",
      "echo",
      "--name",
      "x",
      "--count",
      "notanumber",
      "--verbose",
      "--raw-field",
      "y",
      "--max-retries",
      "2"
    )

    // cli.test.ts's existing expectations, asserted verbatim.
    expect(exitCode).not.toBe(0)
    expect(stdout.trim()).toBe("")

    // The boundary never ran, so it wrote no open event and no close event.
    expect(traceLines(stderr).length).toBe(0)
  })

  test("a successful run's stdout is exactly one JSON line and nothing else", async () => {
    const { stdout, exitCode } = await run("utility", "echo", ...REQUIRED_ECHO_FLAGS)

    expect(exitCode).toBe(0)
    const lines = nonEmptyLines(stdout)
    expect(lines.length).toBe(1)
    expect(stdout).toBe(`${lines[0]}\n`)
    expect(() => JSON.parse(lines[0])).not.toThrow()
  })
})

/** One conforming node's on-disk shape — mirrors `conformance.test.ts`'s own `conformingSpec`. */
const conformingNodeSpec = {
  name: "sample",
  files: {
    "graph-node.ts": [
      "import { Effect, Schema } from \"effect\"",
      "import { make } from \"mag/runtime/graph-node.definition\"",
      "",
      "export const sample = make({",
      "  name: \"sample\",",
      "  description: \"A conforming fixture node for tracing tests.\",",
      "  input: Schema.Struct({ value: Schema.String }),",
      "  success: Schema.Struct({ value: Schema.String }),",
      "  run: (input) => Effect.succeed({ value: input.value })",
      "})",
      ""
    ].join("\n"),
    "errors.ts": [
      "import { Data } from \"effect\"",
      "",
      "export class SampleError extends Data.TaggedError(\"SAMPLE_ERROR\")<{ readonly detail: string }> {}",
      ""
    ].join("\n"),
    "graph-node.test.ts": "// source-only: never dynamically imported by the conformance sweep\n",
    "examples.ts": [
      "export const inputExamples = [{ value: \"hi\" }]",
      "export const successExamples = [{ value: \"hi\" }]",
      ""
    ].join("\n")
  }
}

/**
 * The design's central claim: the tracer must recognise a node run only
 * by the marker the boundary sets, never by whether a span exists at all. `gather`'s
 * `Effect.fn("gather")` span (`graph-nodes/conformance/gather.ts`) and `discovery.ts`'s three
 * more (`directoriesAmong`, `discoverNodes`, `selectNodes`) — plus `rules.ts`'s `runRules` —
 * are real, unmarked spans that flow through our tracer on every `node conformance`
 * run — they must produce nothing. Runs the REAL CLI (`src/cli.ts`), the same subprocess pattern
 * `conformance.test.ts` already uses.
 */
describe("tracing — the in-repo library span (gather + discovery's four unmarked Effect.fn spans, plus runRules)", () => {
  const runRealCli = runHarness(`${import.meta.dir}/../src/cli.ts`)

  test("node conformance --root <fixture> produces exactly two mag: lines, both named conformance", async () => {
    const fixture = nodeFixture([conformingNodeSpec])
    try {
      const { stdout, stderr, exitCode } = await runRealCli("node", "conformance", "--root", fixture.root)

      expect(exitCode).toBe(0)
      expect(nonEmptyLines(stdout).length).toBe(1)

      const lines = traceLines(stderr)
      expect(lines.length).toBe(2)
      expect(lines[0]).toBe("mag: [conformance] entered")
      expect(lines[1]).toMatch(/^mag: \[conformance\] ok \d+\.\d+s$/)
    } finally {
      fixture.cleanup()
    }
  })
})

/**
 * Negative half only: `secret`'s `token` success field must never surface, through
 * the console sink or through stdout. The positive half — that the close *event*'s `value` field
 * itself reads `<redacted>` — is only readable off the file sink, so it lives in `tracing-sinks.test.ts`,
 * through `harness-cli-tracing.ts`, reading the same `secret` fixture registered here.
 */
describe("tracing — the negative half: no secret leaks via the console sink or stdout", () => {
  test("secret's redacted field never appears in mag: lines or stdout; the sibling field is intact", async () => {
    const { stdout, stderr, exitCode } = await run("secret", "--user", "alice")

    expect(exitCode).toBe(0)

    const secretValue = "super-secret-token-value" // must match fixtures/secret.ts's literal

    expect(stderr).not.toContain(secretValue)
    expect(stdout).not.toContain(secretValue)

    // The close line is fixed to `mag: [<name>] ok 1.2s` — no encoded value at all, so this
    // console line can only ever prove the negative (do NOT assert `<redacted>` shows up here;
    // that would mean the line grew a value it is never supposed to carry, per console-sink.ts).
    for (const line of traceLines(stderr)) {
      expect(line).not.toContain(secretValue)
    }

    const parsed = JSON.parse(stdout)
    expect(parsed.token).toBe("<redacted>")
    expect(parsed.user).toBe("alice")
  })
})

/**
 * Tracing adds the `mag:` stderr lines and nothing else. The full no-sink-baseline
 * comparison (via `harness-cli-no-sink.ts`) lives in `tracing-sinks.test.ts` — these cases assert
 * what is already observable here: the pre-tracing stdout/exit-code expectations pinned elsewhere
 * in the suite (`cli.test.ts`) still hold once the `mag:` lines are accounted for.
 */
describe("tracing — no other observable change (full no-sink-baseline comparison lives in tracing-sinks.test.ts)", () => {
  test("success: only the mag: lines are new", async () => {
    const { stdout, stderr, exitCode } = await run("utility", "echo", ...REQUIRED_ECHO_FLAGS, "--verbose")

    expect(exitCode).toBe(0)
    expect(nonEmptyLines(stdout).length).toBe(1)
    const parsed = JSON.parse(stdout)
    expect(typeof parsed.name).toBe("string")
    expect(typeof parsed.count).toBe("number")
    expect(stripTraceLines(stderr)).toBe("") // cli.test.ts's pinned pre-tracing expectation
    expect(traceLines(stderr).length).toBe(2)
  })

  test("tagged failure: only the mag: lines are new", async () => {
    const { stdout, stderr, exitCode } = await run("utility", "boom", "--trigger", "true")

    expect(exitCode).toBe(1)
    expect(stdout).toBe("")
    expect(nonEmptyLines(stripTraceLines(stderr)).length).toBe(1) // cli.test.ts's pinned expectation
    expect(traceLines(stderr).length).toBe(2)
  })

  test("defect: only the mag: lines are new", async () => {
    const { stdout, stderr, exitCode } = await run("throws", "--trigger", "true")

    expect(exitCode).toBe(1)
    expect(stdout).toBe("")
    expect(nonEmptyLines(stripTraceLines(stderr)).length).toBeGreaterThan(0) // cli.test.ts's pinned expectation
    expect(traceLines(stderr).length).toBe(2)
  })
})
