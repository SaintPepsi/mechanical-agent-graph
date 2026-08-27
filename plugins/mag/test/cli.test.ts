import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Glob } from "bun"
import { join } from "node:path"
import { resolveExpected } from "mag/runtime/schema-flags"
import { runHarness } from "./run-harness"
import { nonEmptyLines, stripTraceLines } from "./stderr"
import { REQUIRED_ECHO_FLAGS } from "./echo-flags"

/**
 * Real subprocess integration tests: every assertion here spawns `harness-cli.ts` as an actual
 * `bun` child process (via `Bun.spawn`) and asserts on its real stdout/stderr/exit code. Nothing
 * in this file mocks `effect/unstable/cli`, the schema layer, or the process boundary — this is
 * the first point where real argv reaches the derived flags end to end.
 *
 * The harness path is resolved from `import.meta.dir`, not a bare relative path, so this file
 * behaves identically whether `bun test` is invoked from the repo root (the verification suite's
 * own working directory) or from `plugins/mag`.
 */

const run = runHarness(`${import.meta.dir}/harness-cli.ts`)

/** Drops SGR escapes, so the reader works whether or not the child process was handed a colouring formatter. */
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "")

/**
 * The user-description lines `effect/unstable/cli` prints for one flag, in order. v4 renders
 * `FLAGS` as a two-column table (`CliOutput.ts`'s `renderTable`): one row per flag, the flag's
 * names plus its `Primitive.getTypeName` word on the left, the user-supplied help on the right and
 * empty when the field carries none — the library contributes no type blurb of its own any more.
 * Reads the real rendered row rather than pattern-matching the whole help text, so it survives
 * ANSI styling and flag reordering untouched, and throws when the flag is missing altogether: an
 * absent flag has to fail a provenance test, never quietly return nothing.
 */
const helpLinesFor = (help: string, header: string): readonly string[] => {
  const prefix = `  ${header}`
  const row = stripAnsi(help)
    .split("\n")
    .find((line) => line.startsWith(prefix) && (line.length === prefix.length || line[prefix.length] === " "))
  if (row === undefined) {
    throw new Error(`flag header not found in help output: ${header}`)
  }
  const description = row.slice(prefix.length).trim()
  return description.length === 0 ? [] : [description]
}

/**
 * What `Schema.Int`'s own refinement reports as its expected wording, read at runtime — never a
 * pinned literal. v4 moved this wording off the `description` annotation and onto the check's
 * `expected` key, so `resolveExpected` (schema-flags.ts's own getter for that key) yields it.
 */
const maxRetriesRefinementDescription = resolveExpected(Schema.Int.ast)
if (maxRetriesRefinementDescription === undefined) {
  throw new Error("Schema.Int reports no `expected` wording — there is nothing to assert provenance against")
}

describe("cli — help at every level", () => {
  test("root --help lists every top-level entry with its description, exit 0", async () => {
    const { stdout, exitCode } = await run("--help")

    expect(exitCode).toBe(0)
    expect(stdout).toContain("utility")
    expect(stdout).toContain("Utility fixture commands for exercising the CLI's happy and error paths.")
    expect(stdout).toContain("explode")
    expect(stdout).toContain("Always fails with an error that carries a message field.")
  })

  test("<group> --help lists the group's commands, exit 0", async () => {
    const { stdout, exitCode } = await run("utility", "--help")

    expect(exitCode).toBe(0)
    expect(stdout).toContain("echo")
    expect(stdout).toContain("Echo back the decoded input, unchanged.")
    expect(stdout).toContain("boom")
    expect(stdout).toContain("Always fails with a structured error that carries no message field.")
  })

  test("<group> <command> --help lists the derived flags, exit 0", async () => {
    const { stdout, exitCode } = await run("utility", "echo", "--help")

    expect(exitCode).toBe(0)
    for (const flag of ["--name", "--count", "--verbose", "--nickname", "--raw-field", "--label", "--max-retries", "--strict"]) {
      expect(stdout).toContain(flag)
    }
  })

  test("the leaf help shows --max-retries, never --maxRetries", async () => {
    const { stdout } = await run("utility", "echo", "--help")

    expect(stdout).toContain("--max-retries")
    expect(stdout).not.toContain("--maxRetries")
  })
})

describe("cli — help-line provenance", () => {
  test("the field-type-annotated flag's help line is its annotation", async () => {
    const { stdout } = await run("utility", "echo", "--help")

    const lines = helpLinesFor(stdout, "--name string")
    expect(lines).toContain("The name to echo back.")
  })

  test("the property-signature-annotated optional flag's help line is its annotation", async () => {
    const { stdout } = await run("utility", "echo", "--help")

    const lines = helpLinesFor(stdout, "--label string")
    expect(lines).toContain("A free-form label for this echo.")
  })

  test("the bare field carries no help line at all", async () => {
    const { stdout } = await run("utility", "echo", "--help")

    // The FLAGS table has no library-supplied type blurb of its own, so an unannotated field's
    // description column is simply empty. That makes this the strictest form of the help-line
    // provenance check: any line here at all would have to have come from an annotation this field
    // does not have. --name/--label above still prove the annotated fields do carry theirs.
    const lines = helpLinesFor(stdout, "--raw-field string")
    expect(lines).toEqual([])
  })

  test("--max-retries (refined, unannotated) shows the wording Schema.Int itself reports", async () => {
    const { stdout } = await run("utility", "echo", "--help")

    const lines = helpLinesFor(stdout, "--max-retries number")
    expect(lines).toContain(maxRetriesRefinementDescription)
  })
})

describe("cli — presence and optionality semantics", () => {
  test("echo without the boolean flag decodes false; with it, decodes true", async () => {
    const [withoutFlag, withFlag] = await Promise.all([
      run("utility", "echo", ...REQUIRED_ECHO_FLAGS),
      run("utility", "echo", ...REQUIRED_ECHO_FLAGS, "--verbose")
    ])

    expect(withoutFlag.exitCode).toBe(0)
    expect(withFlag.exitCode).toBe(0)
    expect(JSON.parse(withoutFlag.stdout).verbose).toBe(false)
    expect(JSON.parse(withFlag.stdout).verbose).toBe(true)

    // Same invocation also proves optionality: without the optional flag, the key is absent entirely.
    expect("nickname" in JSON.parse(withoutFlag.stdout)).toBe(false)
  })

  test("an optional boolean (--strict) is absent when unset and decodes true when set, never Some(false)", async () => {
    const [withoutFlag, withFlag] = await Promise.all([
      run("utility", "echo", ...REQUIRED_ECHO_FLAGS),
      run("utility", "echo", ...REQUIRED_ECHO_FLAGS, "--strict")
    ])

    expect(withoutFlag.exitCode).toBe(0)
    expect(withFlag.exitCode).toBe(0)
    expect("strict" in JSON.parse(withoutFlag.stdout)).toBe(false)
    expect(JSON.parse(withFlag.stdout).strict).toBe(true)
  })

  // `Flag.optional` reads raw argv presence, not a resolved default, so an explicit
  // `--strict=false`/`--no-strict` decodes to `false`, distinct from the flag never being passed at
  // all. A field with a `true` default and a `--flag=false` override depends on this distinction
  // existing rather than collapsing an explicit `false` onto the same `None` as absence.
  test("an optional boolean explicitly set to false (--strict=false or --no-strict) decodes false, not absent", async () => {
    const [equalsFalse, negated] = await Promise.all([
      run("utility", "echo", ...REQUIRED_ECHO_FLAGS, "--strict=false"),
      run("utility", "echo", ...REQUIRED_ECHO_FLAGS, "--no-strict")
    ])

    expect(equalsFalse.exitCode).toBe(0)
    expect(negated.exitCode).toBe(0)
    expect(JSON.parse(equalsFalse.stdout).strict).toBe(false)
    expect(JSON.parse(negated.stdout).strict).toBe(false)
  })
})

describe("cli — decoding to real types", () => {
  test("a fully-flagged echo prints one JSON line with correctly-typed fields, exit 0", async () => {
    const { stdout, stderr, exitCode } = await run("utility", "echo", ...REQUIRED_ECHO_FLAGS, "--verbose")

    expect(exitCode).toBe(0)
    expect(nonEmptyLines(stdout).length).toBe(1)
    const parsed = JSON.parse(stdout)
    expect(typeof parsed.name).toBe("string")
    expect(typeof parsed.count).toBe("number")
    expect(stripTraceLines(stderr)).toBe("")
  })

  test("echo --count notanumber fails with a non-zero exit and nothing meaningful on stdout", async () => {
    const { stdout, exitCode } = await run(
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

    expect(exitCode).not.toBe(0)
    expect(stdout.trim()).toBe("")
  })

  test("echo --max-retries 1.5 fails with a real ParseError-shaped rejection, not a JS crash", async () => {
    const { stdout, stderr, exitCode } = await run(
      "utility",
      "echo",
      "--name",
      "x",
      "--count",
      "3",
      "--verbose",
      "--raw-field",
      "y",
      "--max-retries",
      "1.5"
    )

    expect(exitCode).not.toBe(0)
    expect(stdout.trim()).toBe("")
    const strippedStderr = stripTraceLines(stderr)
    expect(strippedStderr.length).toBeGreaterThan(0)
    expect(strippedStderr).toContain(maxRetriesRefinementDescription)
    expect(strippedStderr).not.toContain("ERROR (#0)")
    expect(strippedStderr).not.toContain("Cause")
  })
})

describe("cli — failures exit 1 and name themselves", () => {
  test("boom exits exactly 1 with a single stderr line matching BOOM: {...json...}", async () => {
    const { stdout, stderr, exitCode } = await run("utility", "boom", "--trigger", "true")

    expect(exitCode).toBe(1)
    expect(stdout).toBe("")
    const lines = nonEmptyLines(stripTraceLines(stderr))
    expect(lines.length).toBe(1)
    const match = /^BOOM: (\{.*\})$/.exec(lines[0])
    expect(match).not.toBeNull()
    const parsed = JSON.parse(match![1])
    expect(parsed).toEqual({ code: 500, reason: "always fails" })
  })

  test("explode exits exactly 1 with a single stderr line: EXPLODE: everything is on fire", async () => {
    const { stdout, stderr, exitCode } = await run("explode", "--trigger", "true")

    expect(exitCode).toBe(1)
    expect(stdout).toBe("")
    const lines = nonEmptyLines(stripTraceLines(stderr))
    expect(lines.length).toBe(1)
    expect(lines[0]).toBe("EXPLODE: everything is on fire")
  })

  test("a raw throw inside run (a defect, not a typed failure) still exits 1 with a non-empty stderr line", async () => {
    const { stdout, stderr, exitCode } = await run("throws", "--trigger", "true")

    expect(exitCode).toBe(1)
    expect(stdout).toBe("")
    expect(nonEmptyLines(stripTraceLines(stderr)).length).toBeGreaterThan(0)
  })

  test("a missing required flag gets effect/unstable/cli's own usage output on stderr, with no pretty-printed cause dump", async () => {
    const { stdout, stderr, exitCode } = await run(
      "utility",
      "echo",
      "--count",
      "3",
      "--verbose",
      "--raw-field",
      "y",
      "--max-retries",
      "2"
    )

    expect(exitCode).toBe(1)
    // The usage doc itself is the point of this test — it lands on stderr, alongside the error
    // block, keeping stdout empty.
    expect(stdout).toBe("")
    const strippedStderr = stripTraceLines(stderr)
    expect(strippedStderr).toContain("--name")
    expect(strippedStderr).not.toContain("ERROR (#0)")
    expect(strippedStderr).not.toContain("Cause")
  })
})

describe("cli — no positional arguments", () => {
  test("a positional argument to echo is rejected", async () => {
    const { exitCode } = await run("utility", "echo", ...REQUIRED_ECHO_FLAGS, "--verbose", "extra-positional")

    expect(exitCode).not.toBe(0)
  })
})

const pluginDir = join(import.meta.dir, "..")
const repoRoot = join(import.meta.dir, "..", "..", "..")

/**
 * Every file under `plugins/mag`, excluding `node_modules` and `projects/`: "no build step" is only
 * observable as "no new artefact". `projects/` holds separate packages (the viewer) with a build of their own.
 */
const listGraphFiles = async (): Promise<readonly string[]> => {
  const files: string[] = []
  for await (const file of new Glob("**/*").scan({ cwd: pluginDir, onlyFiles: true, dot: true })) {
    if (!file.startsWith("node_modules/") && !file.startsWith("projects/")) files.push(file)
  }
  return files.sort()
}

describe("cli — no build step", () => {
  test("bun run mag (bare) and the documented help form both start with no build artefact", async () => {
    const before = await listGraphFiles()

    // The shipped empty-registry root has no handler, so the library
    // fails it with `CliError.ShowHelp({ errors: [] })`, prints the help doc, and carries
    // `Runtime.errorExitCode = 0` because that error list is empty — help with exit 0, a passing
    // case rather than a special one. The documented help form is `bun run mag --help`: bun forwards
    // it straight through to the script. Neither invocation depends on the other, so both run
    // concurrently.
    const bare = Bun.spawn(["bun", "run", "mag"], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" })
    const help = Bun.spawn(["bun", "run", "mag", "--help"], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" })
    const [[bareStdout, bareExitCode], [helpStdout, helpExitCode]] = await Promise.all([
      Promise.all([new Response(bare.stdout).text(), bare.exited]),
      Promise.all([new Response(help.stdout).text(), help.exited])
    ])

    const after = await listGraphFiles()

    expect(bareExitCode).toBe(0)
    expect(bareStdout.length).toBeGreaterThan(0)
    expect(helpExitCode).toBe(0)
    expect(helpStdout.length).toBeGreaterThan(0)

    // No dist/, no build/, no .js output anywhere under plugins/mag — the assertion with teeth.
    // `startsWith`, not `includes`: an output directory lands at the package root, while
    // `src/graph-nodes/build/` is a GraphNode named "build", not a build artefact.
    expect(after).toEqual(before)
    expect(after.some((file) => file.startsWith("dist/") || file.startsWith("build/") || file.endsWith(".js"))).toBe(
      false
    )

    // Both invocations went through `bun run mag`, never a bare `mag` — no global install needed.
  })
})
