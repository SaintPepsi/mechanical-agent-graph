import { describe, expect, test } from "bun:test"
import { runHarness } from "./run-harness"

/**
 * Nothing runs before the refusal — no command is built, no argv is
 * parsed, no layer stands up. Empty stdout plus an exit code that never comes from `renderFailure`
 * is the evidence: if `platformRefusal` ran even one step later, `--help` (the most innocuous flag
 * there is) would still short-circuit past it and print help anyway.
 */
const run = runHarness(`${import.meta.dir}/harness-cli-win32.ts`)

describe("cli — win32 is refused before anything else runs", () => {
  test("exits 7, prints the refusal to stderr, and prints nothing to stdout", async () => {
    const { stdout, stderr, exitCode } = await run("--help")

    expect(exitCode).toBe(7)
    expect(stdout).toBe("")
    expect(stderr).toBe(
      "REFUSED: win32 is not a supported platform for mag\n" +
        "run this from a WSL distribution instead (inside WSL this CLI sees linux and proceeds)\n"
    )
  })
})
