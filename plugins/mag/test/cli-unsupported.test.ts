import { describe, expect, test } from "bun:test"
import { runHarness } from "./run-harness"
import { stripTraceLines } from "./stderr"

/**
 * Real subprocess integration test: spawns `harness-cli-unsupported.ts`, which points at
 * `unsupportedRegistry` — a registry holding only the `bad-input` fixture node (a nested
 * `Schema.Struct` input, unsupported by `deriveFlagSpecs`).
 *
 * An unsupported input schema anywhere in the registry must kill the WHOLE
 * CLI *before any argv is parsed* — no command with a silently-wrong surface is ever exposed, not
 * even by accident via `--help`. That is why the harness is spawned with `--help` specifically:
 * the most innocuous flag there is. If `buildCli` failed only after `Command.run` started
 * inspecting argv, `--help` could short-circuit past the failure and print help anyway. This test
 * has its own file and its own harness (rather than sharing `cli.test.ts`) because a bad node
 * kills the whole process — there is no passing case to sit alongside it here.
 *
 * The harness path is resolved from `import.meta.dir`, not a bare relative path, so this file
 * behaves identically whether `bun test` is invoked from the repo root (the verification suite's
 * own working directory) or from `plugins/mag`.
 */

const run = runHarness(`${import.meta.dir}/harness-cli-unsupported.ts`)

describe("cli — an unsupported input schema kills the whole CLI before argv parses", () => {
  test("--help on a registry with an unsupported node exits 1, names the failure, and prints no help", async () => {
    const { stdout, stderr, exitCode } = await run("--help")

    expect(exitCode).toBe(1)

    // --help must not succeed. A test that only checked the exit code would
    // pass even if help printed first, so assert stdout carries no help output at all.
    expect(stdout).toBe("")

    // formatFailure's shape for a tagged error with no `message` field: `${tag}: ${JSON of the
    // remaining enumerable fields}` — see src/runtime/render.ts and src/runtime/errors.ts.
    expect(stripTraceLines(stderr)).toBe(
      `UNSUPPORTED_INPUT_SCHEMA: ${JSON.stringify({ node: "bad-input", field: "nested", type: "Objects" })}\n`
    )
  })
})
